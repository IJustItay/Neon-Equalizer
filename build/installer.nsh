!macro customInit
checkNeonEqualizerRunning:
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name 'Neon Equalizer' -ErrorAction SilentlyContinue) { exit 1 } exit 0"`
  Pop $0
  Pop $1
  StrCmp $0 "1" neonEqualizerRunning neonEqualizerClosed

neonEqualizerRunning:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Neon Equalizer is still running. Close it from the window or tray, then click Retry to continue installing." IDRETRY checkNeonEqualizerRunning IDCANCEL neonEqualizerAbort

neonEqualizerAbort:
  Abort

neonEqualizerClosed:
!macroend

!macro customUnInit
checkNeonEqualizerRunningUninstall:
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name 'Neon Equalizer' -ErrorAction SilentlyContinue) { exit 1 } exit 0"`
  Pop $0
  Pop $1
  StrCmp $0 "1" neonEqualizerRunningUninstall neonEqualizerClosedUninstall

neonEqualizerRunningUninstall:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Neon Equalizer is still running. Close it from the window or tray, then click Retry to continue uninstalling." IDRETRY checkNeonEqualizerRunningUninstall IDCANCEL neonEqualizerAbortUninstall

neonEqualizerAbortUninstall:
  Abort

neonEqualizerClosedUninstall:
!macroend
