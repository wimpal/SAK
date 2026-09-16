use super::content::chapter_match_key;
use super::types::ContentAnalysis;

const MAX_PREFIX_SCAN: usize = 30;
const MAX_REMOVE_FRACTION: f64 = 0.5;
const CONFIDENCE_THRESHOLD: f64 = 0.7;

#[derive(Debug, Clone)]
pub struct DetectionResult {
    pub remove_start: usize,
    pub remove_count: usize,
    #[allow(dead_code)] // used in unit tests and for future diagnostics
    pub confidence: f64,
    pub reason: String,
}

pub fn detect_phantom_prefix(analyses: &[ContentAnalysis]) -> DetectionResult {
    if analyses.is_empty() {
        return skipped("empty spine", 0, 0.0);
    }

    let scan_limit = analyses.len().min(MAX_PREFIX_SCAN);
    let mut chapter_to_indices: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (index, analysis) in analyses.iter().enumerate() {
        for key in &analysis.chapter_keys {
            chapter_to_indices.entry(key.clone()).or_default().push(index);
        }
    }

    let mut best_start = 0usize;
    let mut best_len = 0usize;
    let mut best_confidence = 0.0f64;

    let mut index = 0usize;
    while index < scan_limit {
        while index < scan_limit && is_front_matter(&analyses[index]) {
            index += 1;
        }

        let run_start = index;
        let mut run_len = 0usize;
        let mut run_confidence = 0.0f64;

        while index < scan_limit && is_phantom_candidate(index, analyses, &chapter_to_indices) {
            run_len += 1;
            run_confidence += 0.5;
            index += 1;
        }

        if run_len >= 2 {
            run_confidence = (run_confidence + 0.1).min(1.0);
            if run_len > best_len {
                best_start = run_start;
                best_len = run_len;
                best_confidence = run_confidence;
            }
        }

        if run_len == 0 {
            index += 1;
        }
    }

    if best_len == 0 || best_confidence < CONFIDENCE_THRESHOLD {
        return skipped(
            if best_len == 0 {
                "no phantom TOC run detected"
            } else {
                "confidence below threshold"
            },
            0,
            best_confidence,
        );
    }

    if (best_len as f64 / analyses.len() as f64) > MAX_REMOVE_FRACTION {
        return skipped("would remove too much of the spine", 0, best_confidence);
    }

    DetectionResult {
        remove_start: best_start,
        remove_count: best_len,
        confidence: best_confidence,
        reason: format!(
            "removed {best_len} duplicate TOC entries (confidence {:.2})",
            best_confidence
        ),
    }
}

fn skipped(reason: &str, remove_start: usize, confidence: f64) -> DetectionResult {
    DetectionResult {
        remove_start,
        remove_count: 0,
        confidence,
        reason: reason.to_string(),
    }
}

fn is_front_matter(analysis: &ContentAnalysis) -> bool {
    if analysis.is_substantial {
        return analysis
            .heading
            .as_deref()
            .is_some_and(|title| is_table_of_contents(title));
    }

    analysis
        .heading
        .as_deref()
        .is_some_and(|title| is_table_of_contents(title))
}

fn is_table_of_contents(title: &str) -> bool {
    chapter_match_key(title) == "table of contents"
}

fn is_phantom_candidate(
    index: usize,
    analyses: &[ContentAnalysis],
    chapter_to_indices: &std::collections::HashMap<String, Vec<usize>>,
) -> bool {
    let analysis = &analyses[index];
    if analysis.is_substantial || !analysis.is_title_only {
        return false;
    }

    let Some(title) = analysis.normalized_heading.as_ref() else {
        return false;
    };
    if title.is_empty() {
        return false;
    }

    chapter_to_indices.get(title).is_some_and(|indices| {
        indices
            .iter()
            .any(|&later| later > index && analyses[later].is_substantial)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epub_cleanup::content::analyze_xhtml;

    fn title_only(chapter: &str) -> ContentAnalysis {
        analyze_xhtml(&format!(
            "<html><body><h2>{chapter}</h2><p>subtitle one</p></body></html>"
        ))
    }

    fn substantial(chapter: &str) -> ContentAnalysis {
        analyze_xhtml(&format!(
            "<html><body><h2>{chapter}</h2><p>{}</p></body></html>",
            "word ".repeat(120)
        ))
    }

    fn substantial_with_later_heading(chapter: &str) -> ContentAnalysis {
        analyze_xhtml(&format!(
            "<html><body><h2>Earlier Section</h2><p>{}</p><b>{chapter}</b><p>more</p></body></html>",
            "word ".repeat(120)
        ))
    }

    fn toc_page() -> ContentAnalysis {
        analyze_xhtml(
            "<html><body><h2>Table of Contents</h2><p>Chapter 1</p><p>Chapter 2</p><p>Chapter 3</p><p>Chapter 4</p></body></html>",
        )
    }

    #[test]
    fn detects_duplicate_title_run_after_front_matter() {
        let analyses = vec![
            title_only("Shape Up"),
            toc_page(),
            title_only("Chapter 4: Find the Elements"),
            title_only("Chapter 5: Risks and Rabbit Holes"),
            substantial("Chapter 4: Find the Elements"),
            substantial("Chapter 5: Risks and Rabbit Holes"),
        ];
        let result = detect_phantom_prefix(&analyses);
        assert_eq!(result.remove_start, 2);
        assert_eq!(result.remove_count, 2);
        assert!(result.confidence >= 0.7);
    }

    #[test]
    fn matches_heading_not_first_in_later_file() {
        let analyses = vec![
            title_only("Chapter 4: Find the Elements"),
            title_only("Chapter 5: Risks and Rabbit Holes"),
            substantial_with_later_heading("4: Find the Elements"),
            substantial_with_later_heading("5: Risks and Rabbit Holes"),
        ];
        let result = detect_phantom_prefix(&analyses);
        assert_eq!(result.remove_count, 2);
    }

    #[test]
    fn no_op_when_first_chapter_substantial() {
        let analyses = vec![
            substantial("Chapter 1: Introduction"),
            title_only("Chapter 2: Principles"),
        ];
        let result = detect_phantom_prefix(&analyses);
        assert_eq!(result.remove_count, 0);
    }
}
