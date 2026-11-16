Option Explicit
' 静默启动桥守护进程（不弹黑窗口），日志写到 bridge\bridge.log
Dim fso, sh, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "wscript.exe //B """ & base & "\supervise.vbs""", 0, False
