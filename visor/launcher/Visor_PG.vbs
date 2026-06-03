' Visor_PG — lanzador silencioso.
' Ejecuta el orquestador PowerShell OCULTO (sin ventana de consola).
' Arranca el motor + WhatsApp Web (captura) + el Visor como ventana-app de Chrome.
Dim sh, ps1
ps1 = "C:\Proyectos\Visor_PG\visor\launcher\iniciar_visor.ps1"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
