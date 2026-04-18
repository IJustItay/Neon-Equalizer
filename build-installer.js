const { createWindowsInstaller } = require('electron-winstaller');
const path = require('path');

async function buildInstaller() {
  console.log('Building single executable installer...');
  try {
    const shortPath = 'C:\\Users\\adler\\OneDrive\\913C~1\\ITAYEQ~1';
    await createWindowsInstaller({
      appDirectory: path.join(shortPath, 'release', 'win-unpacked'),
      outputDirectory: path.join(shortPath, 'release', 'installer'),
      authors: 'Itay',
      exe: 'Neon Equalizer.exe',
      setupExe: 'NeonEqualizer_Setup.exe',
      noMsi: true,
      setupIcon: path.join(shortPath, 'assets', 'icon.ico')
    });
    console.log('Installer built successfully! Check the release/installer folder.');
  } catch (e) {
    console.error(`Error building installer: ${e.message}`);
    process.exit(1);
  }
}

buildInstaller();
