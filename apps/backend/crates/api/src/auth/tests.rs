use super::crypto::*;
#[test]
fn recovery_format_normalization_and_hashing() {
    for _ in 0..32 {
        let code = recovery_code();
        assert_eq!(code.len(), 19);
        let groups: Vec<_> = code.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|x| x.len() == 4));
        assert!(
            code.bytes()
                .all(|c| c == b'-' || RECOVERY_ALPHABET.contains(&c))
        );
        assert_eq!(
            normalize_recovery(&code.to_lowercase().replace('-', " ")),
            code.replace('-', "")
        );
    }
    assert_eq!(
        hex::encode(token_hash("abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(token_hash(&opaque_token()), token_hash(&opaque_token()));
}
#[tokio::test]
async fn password_hashes_are_argon2id_and_verify() {
    let hash = hash_secret("1234".into()).await.unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(verify_secret("1234".into(), hash.clone()).await.unwrap());
    assert!(!verify_secret("9999".into(), hash).await.unwrap());
}
