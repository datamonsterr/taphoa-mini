use axum::http::StatusCode;
use serde_json::{Value, json};

pub struct Contract(Value);
impl Contract {
    pub fn load() -> Self {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../docs/api/openapi.yaml"
        );
        let text = std::fs::read_to_string(path).expect("read docs/api/openapi.yaml");
        Self(serde_norway::from_str(&text).expect("parse OpenAPI document"))
    }
    /// Follow a local `#/...` reference (JSON Pointer).
    fn resolve<'a>(&'a self, mut node: &'a Value) -> &'a Value {
        while let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            node = self
                .0
                .pointer(reference.strip_prefix('#').expect("local $ref only"))
                .unwrap_or_else(|| panic!("dangling $ref {reference}"));
        }
        node
    }
    /// Assert `status` is documented for the operation and `body` matches its JSON schema.
    pub fn assert_conforms(&self, template: &str, method: &str, status: StatusCode, body: &Value) {
        let operation = &self.0["paths"][template][method];
        let response = operation["responses"]
            .get(status.as_str())
            .unwrap_or_else(|| panic!("{method} {template}: {status} is not documented"));
        let schema = &self.resolve(response)["content"]["application/json"]["schema"];
        assert!(
            !schema.is_null(),
            "{method} {template} {status}: no JSON schema"
        );
        // Embed the components so local `#/components/...` $refs resolve from the root.
        let root = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "components": self.0["components"],
            "allOf": [schema],
        });
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&root)
            .expect("build validator");
        let errors: Vec<String> = validator
            .iter_errors(body)
            .map(|error| format!("{}: {error}", error.instance_path()))
            .collect();
        assert!(
            errors.is_empty(),
            "{method} {template} {status} violates the contract: {errors:#?}\nbody: {body}"
        );
    }
}
pub mod clerk;
pub mod world;
