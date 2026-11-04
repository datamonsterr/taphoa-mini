use super::normalize_email;

#[test]
fn normalizes_valid_email() {
    assert_eq!(
        normalize_email("  Person.Name+tag@Example.COM  ").as_deref(),
        Some("person.name+tag@example.com")
    );
    let max = format!("{}@a.b", "a".repeat(250));
    assert_eq!(max.len(), 254);
    assert_eq!(normalize_email(&max), Some(max));
}

#[test]
fn rejects_invalid_email() {
    for email in [
        "",
        "  ",
        "a",
        "@a.b",
        "a@",
        "a@localhost",
        "a@@b.c",
        "a b@c.d",
        "a@b. c",
        "a@b.c\nextra",
    ] {
        assert_eq!(normalize_email(email), None, "{email:?}");
    }
    assert_eq!(normalize_email(&format!("{}@a.b", "a".repeat(251))), None);
}
