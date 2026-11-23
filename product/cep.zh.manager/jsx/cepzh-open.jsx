// CEP-ZH host-side opener. Runs in the Adobe application (ExtendScript),
// so it does not depend on Node.js being enabled in the CEP panel.
function CEPZH_OPEN_PATH(path, isFile, helper) {
    try {
        if (helper) {
            var helperFile = new File(helper);
            // v0.3.3+ helper supports --open and brings Explorer to the foreground.
            if (helperFile.exists && helperFile.length > 170000 && app && app.system) {
                var selector = isFile ? " --select" : "";
                app.system('"' + helper + '" --open "' +
                    String(path).replace(/"/g, '\\"') + '"' + selector);
                return "OK";
            }
        }
    } catch (e) {}
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

function CEPZH_RUN_FILE(path) {
    try {
        var file = new File(path);
        if (file.exists && file.execute()) return "OK";
    } catch (e) {}
    return "ERR";
}

function CEPZH_OPEN_URL(url) {
    try {
        var tempDir = Folder.temp ? Folder.temp.fsName : "C:/Windows/Temp";
        var file = new File(tempDir + "/cepzh-open.url");
        file.encoding = "UTF-8";
        if (file.open("w")) {
            file.write("[InternetShortcut]\r\nURL=" + url + "\r\n");
            file.close();
            if (file.execute()) return "OK";
        }
    } catch (e) {}
    return "ERR";
}
