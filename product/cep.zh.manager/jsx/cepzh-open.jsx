// CEP-ZH host-side opener. Uses ExtendScript's ShellExecute-backed Folder/File
// methods only. It never starts cmd.exe or a helper process, so the Adobe host
// cannot be blocked waiting for an external program.
function CEPZH_OPEN_PATH(path, isFile) {
    try {
        if (isFile) {
            var file = new File(path);
            if (file.exists) {
                var parent = file.parent;
                if (parent && parent.exists && parent.execute()) return "OK";
            }
            return "ERR";
        }
        var folder = new Folder(path);
        if (folder.exists && folder.execute()) return "OK";
    } catch (e) {}
    return "ERR";
}
