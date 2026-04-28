# 视频号批量上传工具

批量上传视频到微信视频号，支持多账号管理、定时发布、短剧关联、封面设置。

## 环境要求

- **Node.js** 18 或更高版本
- **Google Chrome** 浏览器
- **FFmpeg** (可选，用于视频预检)

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
node server.js

# 3. 打开浏览器访问
# http://localhost:3000
```

Windows 用户可直接双击 `start.bat`，脚本会自动检查环境并启动。

## 使用流程

1. **账号管理** — 创建/登录视频号账号（扫码登录，支持多账号）
2. **上传视频** — 拖入视频文件和封面，填写描述、标题、短剧名称等
3. **定时发布** — 设置定时发表时间，支持多视频间隔递增
4. **查看结果** — 在结果页查看发布状态，支持导出 CSV

## 项目结构

```
server.js          Express + WebSocket 服务端
batch-upload.js    Playwright 浏览器自动化上传
accounts.js        账号管理（CRUD + 文件持久化）
generate-csv.js    CSV 配置生成工具
start.bat          Windows 启动脚本
public/            Web 前端
```

## 注意事项

- 首次使用需扫码登录：账号页 → 扫码登录 → 扫码后点确定
- 定时发表的实际发布时间 = 设定时间 + 视频上传耗时
- 浏览器 profile 保存在 `browser-profile/` 目录，含登录态，请勿分享
