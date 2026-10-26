//! Small embedded Vietnamese help library; its routes and button labels follow the app.
use super::ops::{invalid, items, parse, schema};
use super::{Tool, ToolContext, ToolError, ToolKind, ToolOutput};
use crate::auth::Action;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, LazyLock},
};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub fn all() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(SearchHelp)]
}
fn normalized(text: &str) -> String {
    text.to_lowercase()
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| if c == 'đ' { 'd' } else { c })
        .collect()
}
fn tokens(text: &str) -> BTreeSet<String> {
    normalized(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}
struct Article {
    slug: &'static str,
    title: &'static str,
    screen: &'static str,
    keywords: &'static str,
    body: &'static str,
}
fn article(slug: &'static str, text: &'static str) -> Result<Article, &'static str> {
    let rest = text.strip_prefix("---\n").ok_or("missing front matter")?;
    let (front, body) = rest
        .split_once("\n---\n")
        .ok_or("missing front matter end")?;
    let field = |name: &str| -> Result<&'static str, &'static str> {
        let mut values = front
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(k, _)| *k == name)
            .map(|(_, v)| v.trim());
        let value = values
            .next()
            .filter(|v| !v.is_empty())
            .ok_or("missing field")?;
        if values.next().is_some() {
            return Err("duplicate field");
        }
        Ok(value)
    };
    let screen = field("screen")?;
    if !screen.starts_with('/') || body.trim().is_empty() {
        return Err("invalid article");
    }
    Ok(Article {
        slug,
        title: field("title")?,
        screen,
        keywords: field("keywords")?,
        body: body.trim(),
    })
}
macro_rules! embed {
    ($slug:literal) => {
        article($slug, include_str!(concat!("../help/", $slug, ".md")))
            .expect("valid embedded help article")
    };
}
static ARTICLES: LazyLock<Vec<Article>> = LazyLock::new(|| {
    vec![
        embed!("ban-camera"),
        embed!("them-san-pham"),
        embed!("nhap-hoa-don"),
        embed!("dieu-chinh-ton"),
        embed!("ghi-chi-phi"),
        embed!("chot-so"),
        embed!("moi-nguoi-ban"),
        embed!("vietqr"),
        embed!("xuat-bao-cao"),
        embed!("hang-ngoai-danh-muc"),
        embed!("dung-tro-ly"),
    ]
});
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    query: String,
}
struct SearchHelp;
#[async_trait]
impl Tool for SearchHelp {
    fn name(&self) -> &'static str {
        "search_help"
    }
    fn kind(&self) -> ToolKind {
        ToolKind::Read
    }
    fn description_vi(&self) -> &'static str {
        "Dùng khi cần hướng dẫn thao tác trong ứng dụng; tìm tối đa 3 bài trợ giúp tiếng Việt theo từ khóa có hoặc không dấu."
    }
    fn parameters(&self) -> Value {
        schema(
            json!({"query":{"type":"string","minLength":1,"maxLength":200}}),
            json!(["query"]),
        )
    }
    fn requires(&self) -> Option<Action> {
        None
    }
    fn label_vi(&self) -> &'static str {
        "Đang tìm hướng dẫn…"
    }
    async fn run(&self, _: &ToolContext, args: Value) -> Result<ToolOutput, ToolError> {
        let query = parse::<Args>(args)?.query;
        let terms = tokens(&query);
        if query.chars().count() > 200 || terms.is_empty() {
            return Err(invalid());
        }
        let mut ranked: Vec<_> = ARTICLES
            .iter()
            .map(|a| {
                let title = tokens(a.title);
                let keywords = tokens(a.keywords);
                let body = tokens(a.body);
                let score = terms.intersection(&title).count() * 5
                    + terms.intersection(&keywords).count() * 3
                    + terms.intersection(&body).count();
                (score, a)
            })
            .filter(|(score, _)| *score > 0)
            .collect();
        ranked.sort_by(|(sa, a), (sb, b)| sb.cmp(sa).then_with(|| a.slug.cmp(b.slug)));
        let rows=ranked.into_iter().map(|(_,a)|json!({"slug":a.slug,"title":a.title,"screen":a.screen,"excerpt":a.body.chars().take(400).collect::<String>()})).collect();
        Ok(items(rows, 3, "Bài hướng dẫn phù hợp"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn help_parser_requires_metadata_and_preserves_body() {
        let a = article(
            "test",
            "---\ntitle: Chốt sổ\nscreen: /close\nkeywords: tiền, két\n---\nBấm Chốt sổ hôm nay.\n",
        )
        .unwrap();
        assert_eq!(a.title, "Chốt sổ");
        assert_eq!(a.screen, "/close");
        assert_eq!(a.body, "Bấm Chốt sổ hôm nay.");
        for bad in [
            "body",
            "---\ntitle: X\n---\nbody",
            "---\ntitle: X\ntitle: Y\nscreen: /\nkeywords: x\n---\nbody",
        ] {
            assert!(article("bad", bad).is_err());
        }
    }
    #[test]
    fn articles_are_complete_and_search_normalizes_vietnamese() {
        assert!((8..=12).contains(&ARTICLES.len()));
        assert_eq!(tokens("CHỐT SỔ ĐẦU ngày"), tokens("chot so dau ngay"));
        assert_eq!(tokens("chốt sổ"), tokens("chot so"));
        let mut slugs: BTreeSet<_> = BTreeSet::new();
        for article in ARTICLES.iter() {
            assert!(slugs.insert(article.slug));
            assert!(!article.keywords.is_empty());
        }
    }
}
