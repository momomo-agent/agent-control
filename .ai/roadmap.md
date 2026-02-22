## F014: goal-runner LLM 集成

agent 看 snapshot 自主决策下一步，循环执行直到目标达成。

### Phase 1: 核心循环
- [ ] `goal-runner.js` 新增 `run` 命令：给定 goal，自动循环 observe → LLM 决策 → act → observe
- [ ] LLM 调用抽象：支持任意 OpenAI-compatible API（环境变量配置）
- [ ] 循环终止条件：LLM 判断 goal 达成 / 最大步数 / 连续失败

### Phase 2: prompt 工程
- [ ] system prompt：你是 GUI 操作 agent，看 snapshot 决定下一步操作
- [ ] 每轮输入：goal + 当前 snapshot + 历史操作摘要
- [ ] 输出格式：JSON `{action, ref, text?, done, reason}`

### Phase 3: 验证
- [ ] Web 平台端到端测试：goal="在 example.com 找到 More information 链接并点击"
- [ ] 生成 HTML report
- [ ] git commit [F✓]
