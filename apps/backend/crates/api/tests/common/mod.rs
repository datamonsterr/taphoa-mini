#![allow(dead_code)]
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
    /// Inspect an operation, including bodyless responses and required headers.
    #[allow(dead_code)]
    pub fn operation(&self, template: &str, method: &str) -> &Value {
        let operation = &self.0["paths"][template][method];
        assert!(operation.is_object(), "missing {method} {template}");
        operation
    }
    /// Validate a standalone component using the document's local references.
    #[allow(dead_code)]
    pub fn schema_accepts(&self, name: &str, body: &Value) -> bool {
        let schema = &self.0["components"]["schemas"][name];
        assert!(schema.is_object(), "missing schema {name}");
        self.validator(schema).is_valid(body)
    }
    fn validator(&self, schema: &Value) -> jsonschema::Validator {
        let root = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "components": self.0["components"],
            "allOf": [schema],
        });
        jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&root)
            .expect("build validator")
    }
    /// Validate the JSON event/data representation of an SSE frame.
    #[allow(dead_code)]
    pub fn assert_stream_conforms(&self, template: &str, body: &Value) {
        let response = &self.operation(template, "post")["responses"]["200"];
        let schema = &self.resolve(response)["content"]["text/event-stream"]["schema"];
        assert!(schema.is_object(), "missing SSE schema");
        assert!(
            self.validator(schema).is_valid(body),
            "invalid SSE frame: {body}"
        );
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
pub mod voice;
pub mod world;
