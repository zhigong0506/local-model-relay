' Start Local Model Relay in background.
Set Shell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
ProjectDir = Fso.GetParentFolderName(WScript.ScriptFullName)
Shell.CurrentDirectory = ProjectDir
If Not Fso.FolderExists(ProjectDir & "\logs") Then
  Fso.CreateFolder(ProjectDir & "\logs")
End If
Shell.Run "cmd /c node scripts\launch-server.mjs >> logs\relay.log 2>&1", 0, False
