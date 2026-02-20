# Taste — agent-control

## 参照物

1. **Playwright CLI** — 简洁的命令行 API，`page.click()` 一行搞定
2. **Apple Accessibility Inspector** — 语义化元素树，role + label + value
3. **adb shell input** — 极简操作接口，tap/swipe/text 三个命令覆盖 90% 场景

## 品味标准

### CLI 体验
- 命令 ≤ 5 个 token：`agent-control -p web click @e3`
- 错误信息带 hint，不只报错码
- snapshot 输出人类可读，LLM 也能直接消费

### 代码质量
- 每个 driver 独立可运行，不依赖其他 driver
- 新平台接入只需实现 snapshot/click/fill/screenshot 四个方法
- 零配置启动：clone → npm install → 能跑

### goal-runner 体验
- observe 返回结构化状态 + 语义摘要，agent 一看就知道当前在哪
- act-observe 自动 diff，agent 知道操作产生了什么变化
- report 生成可视化 HTML，人类一眼看懂执行过程

## 反面教材（不要变成这样）
- Appium：配置地狱，启动要 30 秒
- Selenium Grid：过度工程化，简单操作也要写一堆 boilerplate
- 内置 LLM 决策：agent-control 是手不是脑，不要越界
