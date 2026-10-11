---
title: 安装
---

# 安装

从 [GitHub Releases](https://github.com/suenak/qzone-memory/releases) 下载与设备对应的最新版本。

> **首次启动需要激活。** 同意使用须知后，在激活界面输入账号与密码完成设备绑定。一个账号最多 3 台设备，不区分电脑或手机；激活后离线也可正常使用。详见[首次归档](../first-archive/)。

## Windows

下载 `.exe` 安装程序并完成安装。系统需要 Windows 10 或更新版本，通常已包含 WebView2。

> **从 1.2.1 或更早版本升级**：安装目录名随应用名改为 `qzone-memory`，请先在「应用和功能」里卸载旧版，再安装新版。**归档数据不受影响**——它按应用标识符存放，不随程序卸载一起删除。

## macOS

根据设备下载 Intel 或 Apple Silicon 对应的 `.dmg`。安装包为临时签名且未做公证，首次启动时系统会拦截，需要在「系统设置 → 隐私与安全性」中确认打开。

## Android

下载 `.apk`，允许浏览器或文件管理器安装应用后按提示完成安装。请仅从项目 Releases 页面获取安装包。

## iOS

下载 `.ipa`。它是**未签名**的，需要自行用 AltStore、SideStore、Sideloadly 等工具重签名后才能安装，不能直接安装，也不能提交 App Store。上手成本不低，建议有重签名经验的用户再尝试。

## 关于 Linux 与 NixOS

1.2.2 起不再提供 Linux（AppImage / deb / rpm）与 NixOS 的安装包，发布流水线也不再产出这两类产物，仓库中用于源码构建的 Nix flake 已一并移除。

从源码在 Linux 上自行构建在技术上仍然可行（Tauri 支持该平台），但项目不再对它做构建验证与发布，遇到问题需要自行排查。构建方式见[开发](../development/)。
