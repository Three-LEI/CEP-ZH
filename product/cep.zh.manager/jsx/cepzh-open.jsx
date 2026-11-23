// CEP-ZH host-side opener. Runs in the Adobe application (ExtendScript),
// so it does not depend on Node.js being enabled in the CEP panel.
//
// File/folder paths are passed through a UTF-8 request file. This keeps the
// command line ASCII-only and avoids ExtendScript/CMD Unicode path failures.
function CEPZH_OPEN_PATH(path, isFile, helper) {
    try {
        if (helper) {
            var helperFile = new File(helper);
            // v0.4.0+ helper supports --open-request and foreground activation.
            if (helperFile.exists && helperFile.length > 178000) {
                var request = new File(Folder.temp.fsName + "/cepzh-open-request.txt");
                request.encoding = "UTF-8";
                if (request.open("w")) {
                    request.write(String(path) + "\n" + (isFile ? "1" : "0") + "\n");
                    request.close();
                    var command = 'cmd.exe /c ""' + helperFile.fsName +
                        '" --open-request "' + request.fsName + '""';
                    try {
                        if (typeof system !== "undefined" && system.callSystem) {
                            system.callSystem(command);
                            return "OK";
                        }
                    } catch (e) {}
                    try {
                        if (app && app.system) {
                            app.system(command);
                            return "OK";
                        }
                    } catch (e) {}
                }
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
