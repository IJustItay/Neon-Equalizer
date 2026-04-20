# Neon Equalizer - Screenshot Capture Script
# Double-click to run. Opens the app, waits, then captures screenshots of each tab.
# Outputs to docs/images/

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ScreenshotHelper {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int n);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindBiggestWindow(int[] pids) {
        IntPtr best = IntPtr.Zero; int bestArea = 0;
        EnumWindows((hwnd, lp) => {
            uint wpid; GetWindowThreadProcessId(hwnd, out wpid);
            bool match = false;
            foreach (int p in pids) if ((int)wpid == p) { match = true; break; }
            if (!match || !IsWindowVisible(hwnd)) return true;
            RECT r; GetWindowRect(hwnd, out r);
            int area = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = hwnd; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
"@

$rootDir = Split-Path $PSScriptRoot -Parent
$outDir  = Join-Path $rootDir "docs\images"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Capture-Window($hwnd, $path) {
    $rect = New-Object ScreenshotHelper+RECT
    [ScreenshotHelper]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    if ($w -lt 10 -or $h -lt 10) { Write-Host "  Bad size: ${w}x${h}"; return }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($w, $h))
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  Saved: $path"
}

function Send-ClickTab($tabLabel) {
    # Send key combo to navigate (app uses keyboard shortcuts)
    [System.Windows.Forms.SendKeys]::SendWait("")
}

# ── Launch app ────────────────────────────────────────────────
$exePath = Join-Path $rootDir "release\win-unpacked\Neon Equalizer.exe"
if (-not (Test-Path $exePath)) {
    Write-Host "exe not found at $exePath — run 'npm run dist' first."
    Read-Host; exit 1
}

Write-Host "Launching Neon Equalizer..."
$proc = Start-Process $exePath -PassThru
Start-Sleep -Seconds 7  # wait for full load

$pids = (Get-Process | Where-Object { $_.Name -like "*Neon*" -or $_.Name -like "*electron*" }).Id
$hwnd = [ScreenshotHelper]::FindBiggestWindow($pids)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host "Could not find app window. Make sure Neon Equalizer is open."
    Read-Host; exit 1
}

# Resize to a consistent 1400x900 at top-left
[ScreenshotHelper]::ShowWindow($hwnd, 9)
[ScreenshotHelper]::MoveWindow($hwnd, 0, 0, 1400, 900, $true)
[ScreenshotHelper]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 1000

# ── Dark theme screenshots ────────────────────────────────────
Write-Host "`nCapturing dark theme..."

Write-Host "  Tab: Equalizer"
Start-Sleep -Milliseconds 600
Capture-Window $hwnd (Join-Path $outDir "dark-equalizer.png")

# Click AutoEQ tab
[System.Windows.Forms.SendKeys]::SendWait("{TAB}")
Start-Sleep -Milliseconds 400
Write-Host "  (Navigate to AutoEQ tab manually, then press Enter to capture)"
Read-Host "  Press Enter after switching to AutoEQ tab..."
Capture-Window $hwnd (Join-Path $outDir "dark-autoeq.png")

Write-Host "  (Navigate to Tools tab, then press Enter)"
Read-Host "  Press Enter after switching to Tools tab..."
Capture-Window $hwnd (Join-Path $outDir "dark-tools.png")

Write-Host "  (Navigate to Advanced tab, then press Enter)"
Read-Host "  Press Enter after switching to Advanced tab..."
Capture-Window $hwnd (Join-Path $outDir "dark-advanced.png")

Write-Host "  (Navigate to About tab, then press Enter)"
Read-Host "  Press Enter after switching to About tab..."
Capture-Window $hwnd (Join-Path $outDir "dark-about.png")

# ── Light theme ───────────────────────────────────────────────
Write-Host "`n(Click the 'Light' button in the titlebar to switch theme, then press Enter)"
Read-Host "  Press Enter after switching to Light theme, back on Equalizer tab..."
Capture-Window $hwnd (Join-Path $outDir "light-equalizer.png")

Write-Host "`nDone! Screenshots saved to: $outDir"
Read-Host "Press Enter to exit"
