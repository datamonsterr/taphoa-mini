mod aging;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn customer_validation_bounds_and_trimming() {
        assert_eq!(
            validate_profile("  An  ", None, None, Some(0)).unwrap(),
            "An"
        );
        for name in ["", "  ", &"a".repeat(81)] {
            assert!(validate_profile(name, None, None, None).is_err());
        }
        assert!(
            validate_profile(
                &"é".repeat(80),
                Some(&"1".repeat(20)),
                Some(&"n".repeat(200)),
                None
            )
            .is_ok()
        );
        assert!(validate_profile("A", Some(&"1".repeat(21)), None, None).is_err());
        assert!(validate_profile("A", None, Some(&"n".repeat(201)), None).is_err());
        assert!(validate_profile("A", None, None, Some(-1)).is_err());
    }
}
fn validate_profile(
    _name: &str,
    _phone: Option<&str>,
    _note: Option<&str>,
    _limit: Option<i64>,
) -> crate::ApiResult<String> {
    todo!("profile validation")
}
