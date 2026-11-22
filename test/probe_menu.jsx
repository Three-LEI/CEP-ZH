#target aftereffects
(function () {
    var outPath = "F:/DSH Workspace/Adobe通用CEP注入汉化/test/menu_probe.txt";
    var f = new File(outPath);
    f.encoding = "UTF-8";
    f.open("w");
    f.writeln("AE version: " + app.version);
    f.writeln("time: " + new Date().toString());
    var candidates = [
        "Overlord", "FreqReact", "CamFlow", "Break It", "Easify 2 Pro", "Flow",
        "AtomX", "MYFX", "音频资产管理", "杂鱼极简工具箱", "杂鱼-合成序列复制脚本",
        "杂鱼-关键帧曲线编辑工具", "杂鱼-蓝宝石&BCC汉化工具", "杂鱼-表达式修复工具",
        "AE Localizer Bridge", "Motion Bro", "BeatEdit"
    ];
    for (var i = 0; i < candidates.length; i++) {
        var n = candidates[i];
        var id = -1;
        var err = "";
        try { id = app.findMenuCommandId(n); } catch (e) { err = e.toString(); }
        f.writeln(n + " => " + id + (err ? ("  err=" + err) : ""));
    }
    f.close();
})();
