// afterPack hook — clean extended attributes before signing
const { execSync } = require('child_process');

module.exports = async function (context) {
  const appOutDir = context.appOutDir;
  console.log(`  • cleaning xattrs from ${appOutDir}`);
  try {
    execSync(`xattr -cr "${appOutDir}"`, { stdio: 'inherit' });
  } catch (e) {
    // xattr may fail on some files, that's ok
    console.log(`  • xattr clean warning: ${e.message}`);
  }
};
