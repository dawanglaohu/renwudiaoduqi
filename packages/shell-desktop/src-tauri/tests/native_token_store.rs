#![cfg(all(test, any(target_os = "windows", target_os = "macos")))]

use std::time::{SystemTime, UNIX_EPOCH};

struct Cleanup(keyring::Entry);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.0.delete_credential();
    }
}

#[test]
fn token_survives_a_fresh_entry() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let account = format!("token-test-{}-{nonce}", std::process::id());
    let service = "com.agsched.desktop.test";
    let cleanup = Cleanup(keyring::Entry::new(service, &account).unwrap());
    let token = format!("native-storage-probe-{nonce}");

    let writer = keyring::Entry::new(service, &account).unwrap();
    writer.set_password(&token).unwrap();
    drop(writer);

    let reader = keyring::Entry::new(service, &account).unwrap();
    assert_eq!(reader.get_password().unwrap(), token);
    reader.delete_credential().unwrap();
    assert!(matches!(reader.get_password(), Err(keyring::Error::NoEntry)));
    drop(cleanup);
}
