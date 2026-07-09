' Open the Local Model Relay control panel. Starts the service first if needed.
Set Shell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
ProjectDir = Fso.GetParentFolderName(WScript.ScriptFullName)
ScriptPath = ProjectDir & "\scripts\launch-panel.ps1"
Shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ScriptPath & """", 0, False
