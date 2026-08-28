//! Real Android build-tool smoke. CI does not install the Android SDK, so operators run this before
//! bringing a signer machine into the fleet.

use std::path::{Path, PathBuf};

use android_signer::apk::{validate_unsigned_zip_structure, validate_zip_structure};
use android_signer::process::{AndroidTools as _, CommandAndroidTools};

#[test]
#[ignore = "requires Android SDK build-tools and APK_SIGNER_SMOKE_APK"]
fn signs_and_verifies_a_real_raw_apk() {
    let sdk = PathBuf::from(std::env::var_os("APK_SIGNER_ANDROID_SDK_ROOT").expect("SDK root"));
    let input = PathBuf::from(std::env::var_os("APK_SIGNER_SMOKE_APK").expect("smoke APK"));
    let tools = CommandAndroidTools::discover(Some(&sdk)).unwrap();
    let manifest = tools.manifest(&input).unwrap();
    validate_unsigned_zip_structure(&input).unwrap();
    tools.assert_unsigned(&input).unwrap();

    let key = tools.generate_key(&manifest.package_name).unwrap();
    let other_key = tools.generate_key("me.sproutos.app.pother").unwrap();
    assert_ne!(key.certificate_sha256, other_key.certificate_sha256);
    let temp = tempfile::tempdir().unwrap();
    let signed = temp.path().join("signed.apk");
    tools.sign(&input, &signed, &key).unwrap();
    validate_zip_structure(&signed).unwrap();
    assert_eq!(tools.manifest(&signed).unwrap(), manifest);
    assert_eq!(
        tools.verify_signed(&signed).unwrap(),
        key.certificate_sha256
    );
    assert!(Path::new(&signed).is_file());
}
