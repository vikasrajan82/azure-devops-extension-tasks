/// <reference path="../typings/main.d.ts" />
import AdmZip = require("adm-zip");
import temp = require("temp");
import fs = require("fs");
import path = require("path");
import Q = require("q");
import tl = require("vsts-task-lib/task");
import _ = require("lodash");

export class VSIXEditor {
    private zip: AdmZip;
    private edit: boolean = false;

    private versionNumber: string = null;
    private id: string = null;
    private publisher: string = null;
    private extensionName: string = null;
    private extensionVisibility: string = null;

    constructor(public input: string,
        public output: string) {
        this.zip = new AdmZip(input);
    }

    public startEdit() {
        if (this.edit) { throw new Error("Edit is already started"); }
        this.edit = true;
        tl.debug("Editing started");
    }

    public endEdit(): Q.Promise<any> {
        this.validateEditMode();

        if (!this.hasEdits()) { return Q(null); }

        const deferred = Q.defer();

        temp.track();

        Q.nfcall(temp.mkdir, "vsixeditor")
        .then((dirPath: string) => {
            tl.debug("Finalizing edit");
            tl.debug("Extracting files to " + dirPath);
            this.zip.extractAllTo(dirPath, true);
            return dirPath;
        })
        .then(dirPath => {
            tl.debug("Editing VSIX manifest");
            return this.editVsixManifest(dirPath).then(() => dirPath);
        })
        .then(dirPath => {
            tl.debug("Editing VSO manifest");
            return this.editVsoManifest(dirPath).then(() => dirPath);
        })
        .then(dirPath => {
            let archiver = require("archiver");
            let output = fs.createWriteStream(this.output);
            let archive = archiver("zip");

            tl.debug("Creating final archive file at " + this.output);

            output.on("close", function () {
                tl.debug(archive.pointer() + " total bytes");
                tl.debug("archiver has been finalized and the output file descriptor has closed.");
                deferred.resolve();
            });

            archive.on("error", err => deferred.reject(err));

            archive.pipe(output);

            archive.bulk([
                { expand: true, cwd: dirPath, src: ["**/*"] }
            ]);
            archive.finalize();
            tl.debug("Final archive file created");
        })
        .fail (err => deferred.reject(err));

        return deferred.promise;
    }

    private editVsoManifest(dirPath: string) {
        let deferred = Q.defer<boolean>();

        let vsoManifestPath = path.join(dirPath, "extension.vsomanifest");
        fs.readFile(vsoManifestPath, "utf8", (err, vsoManifestData) => {
            if (err) { throw err; }
            fs.writeFile(vsoManifestPath, vsoManifestData, () => {
                deferred.resolve(true);
            });
        });
        return deferred.promise;
    }

    private editVsixManifest(dirPath: string) {
        let deferred = Q.defer<boolean>();
        let x2jsLib = require("x2js");
        let x2js = new x2jsLib();

        let vsixManifestPath = path.join(dirPath, "extension.vsixmanifest");
        fs.readFile(vsixManifestPath, "utf8", (err, vsixManifestData) => {
            if (err) { throw err; }

            let vsixmanifest = x2js.xml2js(vsixManifestData);
            let identity = vsixmanifest.PackageManifest.Metadata.Identity;

            if (this.versionNumber) { identity._Version = this.versionNumber; }
            if (this.id) { identity._Id = this.id; }
            if (this.publisher) { identity._Publisher = this.publisher; }
            if (this.editExtensionName) { vsixmanifest.PackageManifest.Metadata.DisplayName = this.extensionName; }
            if (this.extensionVisibility) {
                let flagsEditor = new GalleryFlagsEditor(vsixmanifest.PackageManifest.Metadata.GalleryFlags);

                if (this.extensionVisibility.toLowerCase() === "private") {
                    vsixmanifest.PackageManifest.Metadata.GalleryFlags = flagsEditor.removePublicFlag();
                } else if (this.extensionVisibility.toLowerCase() === "public") {
                    vsixmanifest.PackageManifest.Metadata.GalleryFlags = flagsEditor.addPublicFlag();
                }
            }
            vsixManifestData = x2js.js2xml(vsixmanifest);

            fs.writeFile(vsixManifestPath, vsixManifestData, () => {
                deferred.resolve(true);
            });
            deferred.resolve(true);
        });

        return deferred.promise;
    }

    public hasEdits(): boolean {
        return <boolean>(this.versionNumber
            || this.id
            || this.publisher
            || this.extensionName
            || (this.extensionVisibility && this.extensionVisibility !== "default"));
    }

    public editVersion(version: string) {
        this.validateEditMode();
        this.versionNumber = version;
    }

    public editExtensionName(name: string) {
        this.validateEditMode();
        this.extensionName = name;
    }

    public editExtensionVisibility(visibility: string) {
        this.validateEditMode();
        this.extensionVisibility = visibility;
    }

    public editId(id: string) {
        this.validateEditMode();
        this.id = id;
    }

    public editPublisher(publisher: string) {
        this.validateEditMode();
        this.publisher = publisher;
    }

    private validateEditMode() {
        if (!this.edit) { throw  new Error("Editing is not started"); }
    }
}

class GalleryFlagsEditor {
    constructor(public galleryFlagsEditor: string) {
    }

    public addPublicFlag(): string {
        let flags = this.getFlags();
        flags.push("Public");
        return this.joinFlags(flags);
    }

    public removePublicFlag(): string {
        let flags = this.getFlags();
        _.remove(flags, v => v === "Public");
        return this.joinFlags(flags);
    }

    private joinFlags(flags: string[]): string {
        return _.uniq(flags).join(" ");
    }

    private getFlags(): string[] {
        let flags = this.galleryFlagsEditor.split(" ");
        _.remove(flags, v => v === "");
        return flags;
    }
}