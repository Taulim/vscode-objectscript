import * as path from "path";
import * as vscode from "vscode";
import * as url from "url";
import { AtelierAPI } from "../../api";
import { Directory } from "./Directory";
import { File } from "./File";
import { fireOtherStudioAction, OtherStudioAction } from "../../commands/studio";
import { StudioOpenDialog } from "../../queries";
import { studioOpenDialogFromURI } from "../../utils/FileProviderUtil";
import { outputChannel, redirectDotvscodeRoot, workspaceFolderOfUri } from "../../utils/index";
import { workspaceState } from "../../extension";

declare function setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): NodeJS.Timeout;

export type Entry = File | Directory;

export class FileSystemProvider implements vscode.FileSystemProvider {
  public root = new Directory("", "");

  public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private _bufferedEvents: vscode.FileChangeEvent[] = [];
  private _fireSoonHandle?: NodeJS.Timer;

  public constructor() {
    this.onDidChangeFile = this._emitter.event;
  }

  // Used by import and compile to make sure we notice its changes
  public fireFileChanged(uri: vscode.Uri): void {
    // Remove entry from our cache
    this._lookupParentDirectory(uri).then((parent) => {
      const name = path.basename(uri.path);
      parent.entries.delete(name);
    });
    // Queue the event
    this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }

  public stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this._lookup(uri);
  }

  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    uri = redirectDotvscodeRoot(uri);
    const parent = await this._lookupAsDirectory(uri);
    const api = new AtelierAPI(uri);
    if (!api.active) {
      throw vscode.FileSystemError.Unavailable(`${uri.toString()} is unavailable`);
    }
    const { query } = url.parse(uri.toString(true), true);
    const csp = query.csp === "" || query.csp === "1";
    const folder = !csp
      ? uri.path.replace(/\//g, ".")
      : uri.path === "/"
      ? ""
      : uri.path.endsWith("/")
      ? uri.path
      : uri.path + "/";
    // get all web apps that have a filepath (Studio dialog used below returns REST ones too)
    const cspApps = csp ? await api.getCSPApps().then((data) => data.result.content || []) : [];
    const cspSubfolderMap = new Map<string, vscode.FileType>();
    const prefix = folder === "" ? "/" : folder;
    for (const app of cspApps) {
      if ((app + "/").startsWith(prefix)) {
        const subfolder = app.slice(prefix.length).split("/")[0];
        if (subfolder) {
          cspSubfolderMap.set(subfolder, vscode.FileType.Directory);
        }
      }
    }
    const cspSubfolders = Array.from(cspSubfolderMap.entries());
    return studioOpenDialogFromURI(uri)
      .then((data) => data.result.content || [])
      .then((data) => {
        const results = data
          .filter((item: StudioOpenDialog) =>
            item.Type === "10"
              ? csp && !item.Name.includes("/") // ignore web apps here because there may be REST ones
              : item.Type === "9" // class package
              ? !csp
              : csp
              ? item.Type === "5" // web app file
              : true
          )
          .map((item: StudioOpenDialog) => {
            const name = item.Name;
            const fullName = folder === "" ? name : csp ? folder + name : folder + "/" + name;
            if (item.Type === "10" || item.Type === "9") {
              if (!parent.entries.has(name)) {
                parent.entries.set(name, new Directory(name, fullName));
              }
              return [name, vscode.FileType.Directory];
            } else {
              return [name, vscode.FileType.File];
            }
          });
        if (!csp) {
          return results;
        }
        return results.concat(cspSubfolders);
      })
      .catch((error) => {
        if (error) {
          console.log(error);
          if (error.errorText.includes(" #5540:")) {
            const message = `User '${api.config.username}' cannot list ${
              csp ? "web application" : "namespace"
            } contents. To resolve this, execute the following SQL in the ${api.config.ns.toUpperCase()} namespace:\n\t GRANT EXECUTE ON %Library.RoutineMgr_StudioOpenDialog TO ${
              api.config.username
            }`;
            outputChannel.appendError(message);
          }
        }
      });
  }

  public createDirectory(uri: vscode.Uri): void | Thenable<void> {
    uri = redirectDotvscodeRoot(uri);
    const basename = path.posix.basename(uri.path);
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    return this._lookupAsDirectory(dirname).then((parent) => {
      const entry = new Directory(basename, uri.path);
      parent.entries.set(entry.name, entry);
      parent.mtime = Date.now();
      parent.size += 1;
      this._fireSoon(
        { type: vscode.FileChangeType.Changed, uri: dirname },
        { type: vscode.FileChangeType.Created, uri }
      );
    });
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    // Use _lookup() instead of _lookupAsFile() so we send
    // our cached mtime with the GET /doc request if we have it
    return this._lookup(uri).then((file: File) => {
      // Update cache entry
      const uniqueId = `${workspaceFolderOfUri(uri)}:${file.fileName}`;
      workspaceState.update(`${uniqueId}:mtime`, file.mtime);
      return file.data;
    });
  }

  private generateFileContent(fileName: string, content: Buffer): { content: string[]; enc: boolean } {
    const fileExt = fileName.split(".").pop().toLowerCase();
    if (fileExt === "cls") {
      const className = fileName.split(".").slice(0, -1).join(".");
      return {
        content: [`Class ${className} {}`],
        enc: false,
      };
    } else if (["int", "inc", "mac"].includes(fileExt)) {
      const routineName = fileName.split(".").slice(0, -1).join(".");
      const routineType = `[ type = ${fileExt}]`;
      return {
        content: [`ROUTINE ${routineName} ${routineType}`],
        enc: false,
      };
    }
    return {
      content: [content.toString("base64")],
      enc: true,
    };
  }

  public writeFile(
    uri: vscode.Uri,
    content: Buffer,
    options: {
      create: boolean;
      overwrite: boolean;
    }
  ): void | Thenable<void> {
    uri = redirectDotvscodeRoot(uri);
    if (uri.path.startsWith("/.")) {
      throw vscode.FileSystemError.NoPermissions("dot-folders not supported by server");
    }
    const { query } = url.parse(uri.toString(true), true);
    const csp = query.csp === "" || query.csp === "1";
    const fileName = csp ? uri.path : uri.path.slice(1).replace(/\//g, ".");
    if (fileName.startsWith(".")) {
      return;
    }
    const api = new AtelierAPI(uri);
    // Use _lookup() instead of _lookupAsFile() so we send
    // our cached mtime with the GET /doc request if we have it
    return this._lookup(uri).then(
      () => {
        // Weirdly, if the file exists on the server we don't actually write its content here.
        // Instead we simply return as though we wrote it successfully.
        // The actual writing is done by our workspace.onDidSaveTextDocument handler.
        // But first check cases for which we should fail the write and leave the document dirty if changed.
        if (fileName.split(".").pop().toLowerCase() === "cls") {
          // Check if the class is deployed
          api.actionIndex([fileName]).then((result) => {
            if (result.result.content[0].content.depl) {
              throw new Error("Cannot overwrite a deployed class");
            }
          });
          // Check if the class name and file name match
          let clsname = "";
          const match = content.toString().match(/^[ \t]*Class[ \t]+(%?[\p{L}\d]+(?:\.[\p{L}\d]+)+)/imu);
          if (match) {
            [, clsname] = match;
          }
          if (clsname === "") {
            throw new Error("Cannot save a malformed class");
          }
          if (fileName.slice(0, -4) !== clsname) {
            throw new Error("Cannot save an isfs class where the class name and file name do not match");
          }
        }
        // Set a -1 mtime cache entry so the actual write by the workspace.onDidSaveTextDocument handler always overwrites.
        // By the time we get here VS Code's built-in conflict resolution mechanism will already have interacted with the user.
        const uniqueId = `${workspaceFolderOfUri(uri)}:${fileName}`;
        workspaceState.update(`${uniqueId}:mtime`, -1);
        return;
      },
      (error) => {
        if (error.code !== "FileNotFound" || !options.create) {
          return Promise.reject();
        }
        // File doesn't exist on the server, and we are allowed to create it.
        // Create content (typically a stub).
        const newContent = this.generateFileContent(fileName, content);

        // Write it to the server
        return api
          .putDoc(
            fileName,
            {
              ...newContent,
              mtime: Date.now(),
            },
            false
          )
          .catch((error) => {
            // Throw all failures
            if (error.errorText && error.errorText !== "") {
              throw vscode.FileSystemError.Unavailable(error.errorText);
            }
            throw vscode.FileSystemError.Unavailable(error.message);
          })
          .then((response) => {
            // New file has been written
            if (response && response.result.ext && response.result.ext[0] && response.result.ext[1]) {
              fireOtherStudioAction(OtherStudioAction.CreatedNewDocument, uri, response.result.ext[0]);
              fireOtherStudioAction(OtherStudioAction.FirstTimeDocumentSave, uri, response.result.ext[1]);
            }
            // Sanity check that we find it there, then make client side update things
            this._lookupAsFile(uri).then(() => {
              this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
            });
          });
      }
    );
  }

  public delete(uri: vscode.Uri, options: { recursive: boolean }): void | Thenable<void> {
    const { query } = url.parse(uri.toString(true), true);
    const csp = query.csp === "" || query.csp === "1";
    const fileName = csp ? uri.path : uri.path.slice(1).replace(/\//g, ".");
    if (fileName.startsWith(".")) {
      return;
    }
    const api = new AtelierAPI(uri);
    return api.deleteDoc(fileName).then((response) => {
      if (response.result.ext) {
        fireOtherStudioAction(OtherStudioAction.DeletedDocument, uri, response.result.ext);
      }
      // Remove entry from our cache
      this._lookupParentDirectory(uri).then((parent) => {
        const name = path.basename(uri.path);
        parent.entries.delete(name);
      });
      this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
    });
  }

  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void | Thenable<void> {
    throw new Error("Not implemented");
    return;
  }
  public copy?(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): void | Thenable<void> {
    throw new Error("Not implemented");
    return;
  }

  public watch(uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => {
      return;
    });
  }

  // Fetch entry (a file or directory) from cache, else from server
  private async _lookup(uri: vscode.Uri): Promise<Entry> {
    if (uri.path === "/") {
      const api = new AtelierAPI(uri);
      await api
        .serverInfo()
        .then()
        .catch(() => {
          throw vscode.FileSystemError.Unavailable(`${uri.toString()} is unavailable`);
        });
    }
    const parts = uri.path.split("/");
    let entry: Entry = this.root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) {
        continue;
      }
      let child: Entry | undefined;
      if (entry instanceof Directory) {
        child = entry.entries.get(part);
        // If the last element of path is dotted and is one we haven't already cached as a directory
        // then it is assumed to be a file.
        if ((!part.includes(".") || i + 1 < parts.length) && !child) {
          const fullName = entry.name === "" ? part : entry.fullName + "/" + part;
          child = new Directory(part, fullName);
          entry.entries.set(part, child);
        }
      }
      if (!child) {
        if (part.includes(".")) {
          return this._lookupAsFile(uri);
        } else {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
      } else if (child instanceof File) {
        // Return cached copy unless changed, in which case return updated one
        return this._lookupAsFile(uri, child);
      } else {
        entry = child;
      }
    }
    return entry;
  }

  private async _lookupAsDirectory(uri: vscode.Uri): Promise<Directory> {
    // Reject attempt to access /node_modules
    if (uri.path.startsWith("/node_modules")) {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }
    const entry = await this._lookup(uri);
    if (entry instanceof Directory) {
      return entry;
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  // Fetch from server and cache it, optionally the passed cached copy if unchanged on server
  private async _lookupAsFile(uri: vscode.Uri, cachedFile?: File): Promise<File> {
    uri = redirectDotvscodeRoot(uri);
    if (uri.path.startsWith("/.")) {
      throw vscode.FileSystemError.NoPermissions("dot-folders not supported by server");
    }

    const { query } = url.parse(uri.toString(true), true);
    const csp = query.csp === "" || query.csp === "1";
    const fileName = csp ? uri.path : uri.path.slice(1).replace(/\//g, ".");
    const name = path.basename(uri.path);
    const api = new AtelierAPI(uri);
    return api
      .getDoc(fileName, undefined, cachedFile?.mtime)
      .then((data) => data.result)
      .then((result) => {
        const fileSplit = fileName.split(".");
        const fileType = fileSplit[fileSplit.length - 1];
        if (!csp && ["bpl", "dtl"].includes(fileType)) {
          const partialUri = Array.isArray(result.content) ? result.content[0] : String(result.content).split("\n")[0];
          const strippedUri = partialUri.split("&STUDIO=")[0];
          const { https, host, port, pathPrefix } = api.config;
          result.content = [
            `${https ? "https" : "http"}://${host}:${port}${pathPrefix}${strippedUri}`,
            "Use the link above to launch the external editor in your web browser.",
            "Do not edit this document here. It cannot be saved to the server.",
          ];
        }
        return result;
      })
      .then(
        ({ ts, content }) =>
          new File(
            name,
            fileName,
            ts,
            Array.isArray(content) ? content.join("\n").length : content.length,
            Array.isArray(content) ? content.join("\n") : content
          )
      )
      .then((entry) =>
        this._lookupParentDirectory(uri).then((parent) => {
          // Store in parent directory's cache
          parent.entries.set(name, entry);
          return entry;
        })
      )
      .catch((error) => {
        if (error?.statusCode === 304 && cachedFile) {
          return cachedFile;
        }
        throw vscode.FileSystemError.FileNotFound(uri);
      });
  }

  private async _lookupParentDirectory(uri: vscode.Uri): Promise<Directory> {
    uri = redirectDotvscodeRoot(uri);
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    return await this._lookupAsDirectory(dirname);
  }

  private _fireSoon(...events: vscode.FileChangeEvent[]): void {
    this._bufferedEvents.push(...events);

    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }

    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents);
      this._bufferedEvents = [];
    }, 5);
  }
}
