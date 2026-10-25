//! Eval headers: the X7 harness pins the business date and tags its runs. They are honoured only
//! when `ASSISTANT_ALLOW_EVAL_HEADERS` is on, and a bad value is ignored, never an error.
use super::config::AssistantConfig;
use axum::http::HeaderMap;
use chrono::NaiveDate;

pub const RUN_HEADER: &str = "x-taphoa-eval-run";
pub const TODAY_HEADER: &str = "x-taphoa-today";
pub const MODEL_HEADER: &str = "x-taphoa-eval-model";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalContext {
    pub run_id: String,
    /// Replaces the business date for the prompt and every tool of the turn.
    pub today: NaiveDate,
    /// Pins one OpenRouter `:free` model instead of the configured fallback list.
    pub model: Option<String>,
}

/// None unless the flag is on and both the run id and the date are valid.
pub fn from_headers(headers: &HeaderMap, config: &AssistantConfig) -> Option<EvalContext> {
    if !config.allow_eval_headers {
        return None;
    }
    let run_id = text(headers, RUN_HEADER).filter(|id| valid_run_id(id))?;
    let today = text(headers, TODAY_HEADER)
        .filter(|date| date.len() == 10)
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())?;
    let model = text(headers, MODEL_HEADER)
        .filter(|id| valid_model(id))
        .map(str::to_owned);
    Some(EvalContext {
        run_id: run_id.to_owned(),
        today,
        model,
    })
}
fn text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}
fn valid_run_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
/// An OpenRouter model id that can never bill: `:free` only.
fn valid_model(id: &str) -> bool {
    id.len() <= 100
        && id
            .strip_suffix(":free")
            .is_some_and(|name| !name.is_empty())
        && id.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'~' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }
    fn on() -> AssistantConfig {
        AssistantConfig {
            allow_eval_headers: true,
            ..AssistantConfig::default()
        }
    }
    const MODEL: &str = "google/gemma-4-31b-it:free";

    #[test]
    fn honoured_with_the_flag_on() {
        let context = from_headers(
            &headers(&[
                (RUN_HEADER, "run-7_a.b:c"),
                (TODAY_HEADER, "2026-02-17"),
                (MODEL_HEADER, MODEL),
            ]),
            &on(),
        )
        .unwrap();
        assert_eq!(context.run_id, "run-7_a.b:c");
        assert_eq!(context.today.to_string(), "2026-02-17");
        assert_eq!(context.model.as_deref(), Some(MODEL));
        // The model header is optional.
        let context = from_headers(
            &headers(&[(RUN_HEADER, "r1"), (TODAY_HEADER, "2026-02-17")]),
            &on(),
        )
        .unwrap();
        assert_eq!(context.model, None);
    }

    #[test]
    fn all_headers_are_ignored_with_the_flag_off() {
        let all = headers(&[
            (RUN_HEADER, "r1"),
            (TODAY_HEADER, "2026-02-17"),
            (MODEL_HEADER, MODEL),
        ]);
        assert_eq!(from_headers(&all, &AssistantConfig::default()), None);
        assert!(from_headers(&all, &on()).is_some());
    }

    #[test]
    fn both_run_and_date_are_required() {
        assert_eq!(from_headers(&headers(&[]), &on()), None);
        assert_eq!(from_headers(&headers(&[(RUN_HEADER, "r1")]), &on()), None);
        assert_eq!(
            from_headers(&headers(&[(TODAY_HEADER, "2026-02-17")]), &on()),
            None
        );
        // The model alone never makes a context.
        assert_eq!(
            from_headers(&headers(&[(MODEL_HEADER, MODEL)]), &on()),
            None
        );
    }

    #[test]
    fn invalid_run_ids_are_ignored() {
        let long = "a".repeat(65);
        for bad in [
            "",
            "has space",
            "slash/x",
            "tab\t",
            "dollar$",
            long.as_str(),
        ] {
            let map = headers(&[(RUN_HEADER, bad), (TODAY_HEADER, "2026-02-17")]);
            assert_eq!(from_headers(&map, &on()), None, "{bad:?}");
        }
        assert!(!valid_run_id("đ"));
        let longest = "a".repeat(64);
        for good in ["a", longest.as_str(), "Run.1:x_y-z"] {
            let map = headers(&[(RUN_HEADER, good), (TODAY_HEADER, "2026-02-17")]);
            assert!(from_headers(&map, &on()).is_some(), "{good}");
        }
    }

    #[test]
    fn invalid_dates_are_ignored() {
        for bad in [
            "2026-2-17",
            "26-02-17",
            "2026/02/17",
            "2026-02-30",
            "2026-13-01",
            "today",
            "",
            "2026-02-17T00:00:00",
            " 2026-02-17",
        ] {
            let map = headers(&[(RUN_HEADER, "r1"), (TODAY_HEADER, bad)]);
            assert_eq!(from_headers(&map, &on()), None, "{bad:?}");
        }
    }

    #[test]
    fn non_free_or_malformed_models_are_ignored() {
        let too_long = format!("{}:free", "m".repeat(96));
        for bad in [
            "openai/gpt-5",
            "google/gemma-4-31b-it",
            "google/gemma-4-31b-it:free:extended",
            ":free",
            "a b/c:free",
            "a/b:FREE",
            too_long.as_str(),
        ] {
            let map = headers(&[
                (RUN_HEADER, "r1"),
                (TODAY_HEADER, "2026-02-17"),
                (MODEL_HEADER, bad),
            ]);
            let context = from_headers(&map, &on()).expect("the rest stays valid");
            assert_eq!(context.model, None, "{bad}");
        }
        let longest = format!("{}:free", "m".repeat(95));
        for good in ["a/b:free", "~vendor/model-1.5_x:free", longest.as_str()] {
            let map = headers(&[
                (RUN_HEADER, "r1"),
                (TODAY_HEADER, "2026-02-17"),
                (MODEL_HEADER, good),
            ]);
            assert_eq!(
                from_headers(&map, &on()).unwrap().model.as_deref(),
                Some(good)
            );
        }
    }
}
