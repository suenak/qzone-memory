//! 离线网页的相对路径媒体包；失败时清理本次产物，成功前不覆盖旧网页。
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct ExportBundle {
    output: PathBuf,
    media: PathBuf,
    name: String,
    temporary: PathBuf,
    copied: usize,
    committed: bool,
}

impl ExportBundle {
    pub(crate) fn new(output: &Path) -> Result<Self, String> {
        if !output.is_absolute()
            || !output
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("html"))
        {
            return Err("请选择一个 HTML 网页保存位置".into());
        }
        let parent = output
            .parent()
            .ok_or("保存位置无效")?
            .canonicalize()
            .map_err(|e| format!("无法访问保存目录：{e}"))?;
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "无法生成导出文件标识")?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let name = format!("shiyi-media-{token}");
        let media = parent.join(&name);
        fs::create_dir(&media).map_err(|e| format!("无法创建媒体文件夹：{e}"))?;
        Ok(Self {
            output: parent.join(output.file_name().ok_or("保存位置无效")?),
            media,
            name,
            temporary: parent.join(format!(".shiyi-export-{token}.tmp")),
            copied: 0,
            committed: false,
        })
    }

    /// 文件名由调用端生成，不使用上游文件名。缺失缓存返回 None，读取失败则中止导出。
    pub(crate) fn copy_media(
        &mut self,
        root: &Path,
        source: &Path,
        name: &str,
    ) -> Result<Option<String>, String> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        {
            return Err("导出媒体文件名无效".into());
        }
        let source = match source.canonicalize() {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("无法读取本地媒体：{e}")),
        };
        let root = root
            .canonicalize()
            .map_err(|e| format!("无法访问媒体目录：{e}"))?;
        if !source.starts_with(&root) || !source.is_file() {
            return Err("本地媒体路径超出保存范围".into());
        }
        fs::copy(source, self.media.join(name)).map_err(|e| format!("复制媒体失败：{e}"))?;
        self.copied += 1;
        Ok(Some(format!("{}/{name}", self.name)))
    }

    pub(crate) fn commit(mut self, html: &str) -> Result<(), String> {
        fs::write(&self.temporary, html).map_err(|e| format!("保存网页失败：{e}"))?;
        fs::rename(&self.temporary, &self.output).map_err(|e| format!("保存网页失败：{e}"))?;
        self.committed = true;
        if self.copied == 0 {
            let _ = fs::remove_dir(&self.media);
        }
        Ok(())
    }
}

impl Drop for ExportBundle {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.temporary);
            let _ = fs::remove_dir_all(&self.media);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> PathBuf {
        let mut bytes = [0; 16];
        getrandom::getrandom(&mut bytes).unwrap();
        let path = std::env::temp_dir().join(format!("shiyi-export-test-{:x?}", bytes));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn exported_media_survives_source_removal_and_html_replacement() {
        let work = workspace();
        let cache = work.join("cache");
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("image.png"), b"saved-image").unwrap();
        let output = work.join("回忆.html");
        fs::write(&output, "old").unwrap();
        let mut bundle = ExportBundle::new(&output).unwrap();
        let relative = bundle
            .copy_media(&cache, &cache.join("image.png"), "image-1.png")
            .unwrap()
            .unwrap();
        assert!(!relative.contains('\\'));
        bundle.commit(&format!("<img src=\"{relative}\">")).unwrap();
        fs::remove_dir_all(&cache).unwrap();
        assert_eq!(fs::read(work.join(relative)).unwrap(), b"saved-image");
        assert!(fs::read_to_string(output).unwrap().contains("shiyi-media-"));
        fs::remove_dir_all(work).unwrap();
    }
    #[test]
    fn failure_keeps_old_html_and_cleans_partial_media() {
        let work = workspace();
        let output = work.join("test.html");
        fs::write(&output, "old").unwrap();
        let mut bundle = ExportBundle::new(&output).unwrap();
        let media = bundle.media.clone();
        assert!(bundle
            .copy_media(&work, &work.join("missing"), "image.png")
            .unwrap()
            .is_none());
        fs::write(work.join("source"), "data").unwrap();
        fs::create_dir(work.join("other-root")).unwrap();
        assert!(bundle
            .copy_media(&work.join("other-root"), &work.join("source"), "image.png")
            .is_err());
        assert!(bundle
            .copy_media(&work.join("wrong-root"), &work.join("source"), "image.png")
            .is_err());
        assert!(bundle
            .copy_media(&work, &work.join("source"), "../escape")
            .is_err());
        drop(bundle);
        assert!(!media.exists());
        assert_eq!(fs::read_to_string(output).unwrap(), "old");
        fs::remove_dir_all(work).unwrap();
    }

    #[test]
    fn commit_failure_cleans_copied_files_and_temporary_html() {
        let work = workspace();
        let output = work.join("existing-directory.html");
        fs::create_dir(&output).unwrap();
        fs::write(work.join("source"), "media").unwrap();
        let mut bundle = ExportBundle::new(&output).unwrap();
        bundle
            .copy_media(&work, &work.join("source"), "image.png")
            .unwrap();
        let media = bundle.media.clone();
        let temporary = bundle.temporary.clone();
        assert!(bundle.commit("new html").is_err());
        assert!(!media.exists());
        assert!(!temporary.exists());
        assert!(output.is_dir());
        fs::remove_dir_all(work).unwrap();
    }
}
