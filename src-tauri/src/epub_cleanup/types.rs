use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub action: String,
    pub removed_spine_items: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}

impl CleanupReport {
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            action: "skipped".to_string(),
            removed_spine_items: 0,
            skipped_reason: Some(reason.into()),
        }
    }

    pub fn cleaned(removed: usize) -> Self {
        Self {
            action: "cleaned".to_string(),
            removed_spine_items: removed as u32,
            skipped_reason: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManifestItem {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub properties: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpineItem {
    pub idref: String,
}

#[derive(Debug, Clone)]
pub struct ContentAnalysis {
    pub heading: Option<String>,
    pub normalized_heading: Option<String>,
    pub chapter_keys: Vec<String>,
    pub is_substantial: bool,
    pub is_title_only: bool,
}
