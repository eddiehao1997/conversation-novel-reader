# TXT 小说阅读器（PWA）

可以安装到手机主屏幕的 TXT 小说阅读器：全屏运行、离线可读，通过 Google Drive 在各设备之间同步阅读进度。

- 自动识别编码（UTF-8 / GBK / Big5）和章节（第X章 / 第X卷 / 番外 …）
- 目录和章节搜索，全书进度百分比（按字数计算），进度定位到段落
- 字号、行距、版心宽度、字体可调；5 种主题（跟随系统 / 白 / 羊皮纸 / 护眼绿 / 夜间）
- 手机上左右滑动切换章节，阅读时自动隐藏顶栏，屏幕保持常亮
- 离线可用：Service Worker 缓存应用本身，书存在本机的 IndexedDB 里
- 电脑版 Chrome / Edge 安装后，可以把 .txt 文件直接拖进来或用「打开方式」打开
- **同步的只有阅读位置**（章节、段落、百分比），书的内容不会上传

## 文件结构

```
index.html             阅读器（页面、样式、脚本都在这一个文件里）
config.js              Google OAuth Client ID（留空 = 不开同步，只用本机）
manifest.webmanifest   PWA 配置（名称、图标、全屏模式、.txt 文件关联）
sw.js                  Service Worker（离线缓存）
icons/                 应用图标
.nojekyll              让 GitHub Pages 原样发布这些文件
```

> ⚠️ 不要把小说 txt 放进仓库。GitHub Pages 是公开的，书只需要在各台设备上导入一次。

## 一、部署到 GitHub Pages

1. 代码已在仓库 `eddiehao1997/conversation-novel-reader` 的 `main` 分支（public 仓库，可以免费使用 Pages）。
2. 打开仓库的 **Settings → Pages**：Source 选 **Deploy from a branch**，Branch 选 `main`，目录选 `/ (root)`，然后保存。
3. 一两分钟后，网站就会在 <https://eddiehao1997.github.io/conversation-novel-reader/> 上线。

到这一步已经可以使用了，只是还没有同步功能。

## 二、开启 Google Drive 同步（约 10 分钟）

进度保存在你自己 Google Drive 的**隐藏应用文件夹**（appDataFolder）里：不占用可见的 Drive 空间，阅读器也只能访问它自己创建的文件，看不到你 Drive 里的其他内容。这个方案不需要服务器。

1. 打开 <https://console.cloud.google.com/>，新建一个项目（例如 `novel-reader`）。
2. **APIs & Services → Library**：搜索 **Google Drive API**，点击 **Enable**。
3. **Google Auth Platform**（即 OAuth 同意屏幕），第一次进入时按向导填写：
   - **Branding**：填写应用名称（例如「小说阅读」）和支持邮箱。
   - **Audience**：User type 选 **External**，Publishing status 保持 **Testing**，在 **Test users** 里加上你自己的 Gmail。
   - **Data Access**：Add or remove scopes，勾选 `…/auth/drive.appdata` 和 `…/auth/userinfo.email`。
4. **Clients → Create client**，Application type 选 **Web application**：
   - **Authorized JavaScript origins**：`https://eddiehao1997.github.io`
   - **Authorized redirect URIs**：`https://eddiehao1997.github.io/conversation-novel-reader/`（**末尾的 `/` 必须保留**，要和地址栏里的网址完全一致）
   - 想在本地测试的话，再加上 `http://localhost:8080`（origin）和 `http://localhost:8080/`（redirect URI）
5. 复制生成的 **Client ID**（形如 `123…-abc….apps.googleusercontent.com`），填进 `config.js`：
   ```js
   window.READER_CONFIG = { googleClientId: '123…-abc….apps.googleusercontent.com' };
   ```
   提交并推送后，GitHub Pages 会自动更新。

说明：

- Client ID 本来就是公开信息（浏览器端应用都会把它暴露出来），可以放心提交到仓库。这里没有 client secret。
- 保持 **Testing** 状态就够用了：只有你加进 Test users 的账号能登录（最多 100 个），不需要提交 Google 审核。想多给几个人用，把他们的 Gmail 加进 Test users 即可。
- 第一次登录时，Google 会提示「此应用未经验证」，点 **继续** 即可，因为这是你自己的应用。

## 三、安装到手机或电脑

| 设备 | 安装方法 |
|---|---|
| iPhone / iPad | 用 **Safari** 打开网址，点 **分享 → 添加到主屏幕** |
| Android | 用 **Chrome** 打开网址，点菜单里的 **安装应用**（或「添加到主屏幕」） |
| 电脑 | 用 Chrome / Edge 打开网址，点地址栏右侧的安装图标 |

然后在每台设备上：

1. 从主屏幕图标打开阅读器，点 **选择 TXT 文件**，导入小说（每台设备只需导入一次）。
2. 点顶栏的 **连接同步**，登录同一个 Google 账号。
3. 之后只要在任意一台设备上继续读：
   - 一台从没读过这本书的设备，打开后会**自动跳到最新进度**；
   - 一台读过、但进度落后的设备，会提示「你在 iPhone 上读到 第X章（57.2%）」，点 **跳转** 才会跳过去。

**iPhone 注意：** 主屏幕上的 App 和 Safari 里的网页是**两份独立的存储**。在 Safari 里导入过的书和登录状态不会带到主屏幕 App 里，所以请在主屏幕 App 里再导入一次、连接一次。

## 同步如何运作

- 每本书用「文件大小 + 前 1MB 内容的 SHA-256」作为 ID，所以文件改名后也能认出是同一本书。
- 在 Drive 隐藏文件夹里，每本书对应一个文件 `<书ID>.json`，内容是 `{章节, 段落, 百分比, 章节名, 书名, 时间, 设备}`。
- 什么时候上传：换章时、App 切到后台时立即上传；连续滚动时，停下 10 秒后上传一次。断网或登录过期期间的进度会先排队，恢复后自动补传。
- 发生冲突时以最后一次写入为准，较新的远端进度只会提示，不会强制跳转。
- 登录方式是 OAuth 重定向（不用弹窗，在 iOS 主屏幕 App 里也能用）。登录令牌约 1 小时有效，过期后下次打开 App 会自动经过 Google 续期（一闪而过）；如果续期失败，顶栏会显示 **重新连接**。
- 想清除同步数据：Google Drive → 设置 → **管理应用** → 找到这个应用 → **删除隐藏的应用数据**。

## 限制

- 中国大陆网络连不上 Google，所以同步不可用；阅读本身不受影响，进度会先存在本机。
- 每台设备都需要导入一次 txt（只同步进度，不同步书）。
- 浏览器的无痕模式会在关闭后清掉书和进度。

## 本地开发

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080/
```

Service Worker 对应用文件采用网络优先策略：部署新版本后，在线打开就会拿到最新版，离线时用缓存。
