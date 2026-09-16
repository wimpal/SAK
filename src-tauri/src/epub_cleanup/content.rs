use super::types::ContentAnalysis;

const SUBSTANTIAL_WORDS: usize = 80;
const SUBSTANTIAL_CHARS: usize = 400;
const TITLE_ONLY_MAX_WORDS: usize = 100;

fn extract_body_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("<body")
        .and_then(|idx| lower[idx..].find('>').map(|rel| idx + rel + 1));
    let end = lower.find("</body>");
    match (start, end) {
        (Some(s), Some(e)) if e > s => html[s..e].to_string(),
        _ => html.to_string(),
    }
}

pub fn normalize_title(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

pub fn chapter_match_key(title: &str) -> String {
    let mut key = normalize_title(title);
    if let Some(rest) = key.strip_prefix("chapter ") {
        key = rest.to_string();
    }
    key
}

pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    collapse_whitespace(&out)
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn count_paragraphs(html: &str) -> usize {
    let lower = html.to_ascii_lowercase();
    lower.matches("<p").count()
}

fn count_linked_paragraphs(html: &str) -> usize {
    let lower = html.to_ascii_lowercase();
    let mut count = 0usize;
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find("<p") {
        let start = search_from + rel;
        let end = lower[start..]
            .find("</p>")
            .map(|idx| start + idx + 4)
            .unwrap_or(lower.len());
        if lower[start..end].contains("<a ") {
            count += 1;
        }
        search_from = end;
    }
    count
}

fn is_toc_stub_layout(html: &str) -> bool {
    let body = extract_body_html(html);
    let lower = body.to_ascii_lowercase();
    if !lower.contains("<h2") {
        return false;
    }
    let paragraph_count = count_paragraphs(&body);
    let linked_paragraphs = count_linked_paragraphs(&body);
    paragraph_count >= 3 && linked_paragraphs >= 3 && linked_paragraphs * 2 >= paragraph_count
}

pub fn extract_all_headings(html: &str) -> Vec<String> {
    let body = extract_body_html(html);
    let mut headings = Vec::new();
    for tag in ["h1", "h2", "h3", "h4", "h5", "h6", "b"] {
        let mut search_from = 0usize;
        let lower = body.to_ascii_lowercase();
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        while let Some(rel) = lower[search_from..].find(&open) {
            let start = search_from + rel;
            let after_open = &body[start..];
            let content_start = match after_open.find('>') {
                Some(idx) => idx + 1,
                None => break,
            };
            let inner = &after_open[content_start..];
            let lower_inner = inner.to_ascii_lowercase();
            let end = match lower_inner.find(&close) {
                Some(idx) => idx,
                None => break,
            };
            let text = strip_tags(&inner[..end]);
            if !text.is_empty() {
                headings.push(text);
            }
            search_from = start + content_start + end + close.len();
        }
    }
    headings
}

pub fn analyze_xhtml(html: &str) -> ContentAnalysis {
    let body = extract_body_html(html);
    let visible = strip_tags(&body);
    let word_count = visible.split_whitespace().count();
    let visible_chars = visible.chars().count();
    let headings = extract_all_headings(html);
    let heading = headings.first().cloned();
    let normalized_heading = heading.as_deref().map(chapter_match_key);
    let chapter_keys = headings
        .iter()
        .map(|value| chapter_match_key(value))
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();

    let is_toc_stub_layout = is_toc_stub_layout(html);
    let is_substantial = !is_toc_stub_layout
        && (word_count >= SUBSTANTIAL_WORDS || visible_chars >= SUBSTANTIAL_CHARS);

    let is_title_only =
        !is_substantial && (word_count <= TITLE_ONLY_MAX_WORDS || is_toc_stub_layout);

    ContentAnalysis {
        heading,
        normalized_heading,
        chapter_keys,
        is_substantial,
        is_title_only,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_title_strips_punctuation() {
        assert_eq!(
            normalize_title("Chapter 4: Find the Elements"),
            "chapter 4 find the elements"
        );
    }

    #[test]
    fn analyze_detects_substantial_body() {
        let html = "<html><body><p>".to_string() + &"word ".repeat(100) + "</p></body></html>";
        let analysis = analyze_xhtml(&html);
        assert!(analysis.is_substantial);
        assert!(!analysis.is_title_only);
    }

    #[test]
    fn analyze_detects_title_only() {
        let html = r#"<html><body><h2>Chapter 4: Find the Elements</h2><p>Move at the right speed</p></body></html>"#;
        let analysis = analyze_xhtml(html);
        assert!(analysis.is_title_only);
        assert_eq!(
            analysis.normalized_heading.as_deref(),
            Some("4 find the elements")
        );
    }

    #[test]
    fn analyze_detects_toc_stub_layout() {
        let html = r#"<html><body><h2>Chapter 15: Move On</h2>
<p><a href="x.html"><i>Let the storm pass</i></a></p>
<p><a href="x.html"><i>Stay debt-free</i></a></p>
<p><a href="x.html"><b>Conclusion</b></a></p>
<p><a href="x.html"><i>Key concepts</i></a></p>
</body></html>"#;
        let analysis = analyze_xhtml(html);
        assert!(!analysis.is_substantial);
        assert!(analysis.is_title_only);
    }
}
