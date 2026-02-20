## F015: 工程清理

### Phase 1: .gitignore
- [ ] 创建 .gitignore（node_modules, .build, runs/, /tmp, *.png artifacts）
- [ ] 确认 git status 干净

### Phase 2: 冗余清理
- [ ] 检查并删除无用文件（重复脚本、废弃 flow JSON、空目录）
- [ ] runs/ 目录归档或 gitignore

### Phase 3: 验证
- [ ] npm install 能跑
- [ ] agent-control --help 正常输出
- [ ] git commit [F✓]
