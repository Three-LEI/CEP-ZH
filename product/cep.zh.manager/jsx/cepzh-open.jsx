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

// Copy the installer out of the CEP extension directory before executing it.
// This avoids a locked extension directory when the installer replaces the panel.
function CEPZH_RUN_FILE(path) {
    try {
        var source = new File(path);
        if (!source.exists) return "ERR";
        var target = new File(Folder.temp.fsName + "/CepZhInstaller.exe");
        if (target.exists) target.remove();
        if (!source.copy(target)) return "ERR";
        if (target.execute()) return "OK";
    } catch (e) {}
    return "ERR";
}
