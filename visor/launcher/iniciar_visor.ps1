# Visor_PG — orquestador de arranque.
# 1) Levanta el MOTOR oculto (npm run dev = servidor Vite :5180 + worker de 32 agentes).
# 2) Abre UNA ventana de Chrome con DOS pestañas: el Visor + WhatsApp Web,
#    en el perfil 'Default' (donde vive la extension de captura).
#    -> Visor habla con la extension (externally_connectable) y WhatsApp Web captura.
#    Todo en una sola ventana: alternas pestañas para vigilar que WA no se desconecte.
#
# Se ejecuta oculto (lo lanza Visor_PG.vbs). Idempotente con el motor: si ya corre, no lo duplica.

$ErrorActionPreference = 'SilentlyContinue'

$VISOR  = 'C:\Proyectos\Visor_PG\visor'
$URL    = 'http://localhost:5180/'
$WA     = 'https://web.whatsapp.com/'
$CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$PERFIL = 'Default'
$LOG    = Join-Path $VISOR 'launcher\arranque.log'

function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Out-File -FilePath $LOG -Append -Encoding utf8 }
function PuertoListo {
  try { return ((Invoke-WebRequest $URL -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) }
  catch { return $false }
}

"=== arranque $([DateTime]::Now) ===" | Out-File -FilePath $LOG -Encoding utf8

# --- 1. MOTOR ---------------------------------------------------------------
if (PuertoListo) {
  Log "motor ya estaba corriendo en 5180"
} else {
  Log "arrancando motor (npm run dev) oculto..."
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev' `
    -WorkingDirectory $VISOR -WindowStyle Hidden
  $listo = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (PuertoListo) { $listo = $true; Log "motor listo tras $($i+1)s"; break }
  }
  if (-not $listo) { Log "ADVERTENCIA: el motor no respondio en 60s" }
}

# --- 2. UNA ventana de Chrome con Visor + WhatsApp Web (dos pestañas) -------
# La primera URL queda como pestaña activa (el Visor); WhatsApp Web en la segunda.
Log "abriendo ventana Chrome: Visor + WhatsApp Web (perfil $PERFIL)"
Start-Process $CHROME -ArgumentList "--profile-directory=$PERFIL", "--new-window", $URL, $WA
Log "listo"
