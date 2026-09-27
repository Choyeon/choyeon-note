/**
 * 示例笔记数据（首次启动 / 未选择笔记目录时的欢迎内容）。
 *
 * 必须导出**工厂函数**而不是共享常量数组：note.js 的 resetConfig 会把这些对象
 * push 进 notes，若多处持有同一批对象，多轮 reset（或用户编辑后再 reset）会
 * 互相污染——编辑第一篇会改到"模板"上，下次 reset 出来的是被改脏的数据。
 * 因此每次调用逐条构造全新对象。
 *
 * @returns {Array<object>} 全新的示例笔记数组
 */
export function createSampleNotes () {
  return [
    {
      id: 'note1',
      title: '2024年第12周工作周报',
      content: `# 2024年第12周工作周报

## 本周完成

- [x] 完成 API 接口文档编写
- [x] 修复用户反馈的登录问题
- [ ] 重构数据查询模块
- [ ] 编写单元测试

## 下周计划

1. 完成用户模块的权限系统设计与开发
2. 配合前端完成接口联调与集成测试
3. 准备季度技术分享会材料

> 注意：下周一有团队评审会议，请提前准备好演示材料。

## 技术笔记

\`\`\`typescript
interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: Date;
}
\`\`\`

以上是笔记数据模型的基础定义。后续会根据业务需求扩展字段，包括更新时间、作者信息和关联笔记引用。

## 相关资源

| 资源名称 | 类型 | 状态 |
|---------|------|------|
| API 接口文档 v2.1 | 文档 | 已完成 |
| 数据库 ER 图 | 图表 | 进行中 |
| 前端组件库文档 | 文档 | 已完成 |
| 部署流水线配置 | 配置 | 待开始 |
`,
      folder: '工作笔记',
      tags: ['工作', '周报'],
      createdAt: new Date('2024-03-22T16:30:00'),
      updatedAt: new Date('2024-03-22T16:30:00'),
      wordCount: 486,
      charCount: 2847,
      lineCount: 42,
      filePath: null
    },
    {
      id: 'note2',
      title: 'API设计文档',
      content: '# API设计文档\n\n本文档描述了系统的API设计规范...',
      folder: '项目文档',
      tags: ['技术', 'API'],
      createdAt: new Date('2024-03-22T14:15:00'),
      updatedAt: new Date('2024-03-22T14:15:00'),
      wordCount: 1200,
      charCount: 6000,
      lineCount: 120,
      filePath: null
    },
    {
      id: 'note3',
      title: '会议纪要',
      content: '# 会议纪要\n\n日期：2024年3月21日\n参会人员：...',
      folder: '工作笔记',
      tags: ['工作', '会议'],
      createdAt: new Date('2024-03-21T18:00:00'),
      updatedAt: new Date('2024-03-21T18:00:00'),
      wordCount: 350,
      charCount: 1800,
      lineCount: 35,
      filePath: null
    },
    {
      id: 'note4',
      title: '2024-03-20',
      content: '# 2024年3月20日\n\n今天的日记...',
      folder: '日记',
      tags: ['日记'],
      createdAt: new Date('2024-03-20T23:45:00'),
      updatedAt: new Date('2024-03-20T23:45:00'),
      wordCount: 500,
      charCount: 2500,
      lineCount: 50,
      filePath: null
    },
    {
      id: 'note5',
      title: 'Vue学习笔记',
      content: '# Vue学习笔记\n\nVue 3 Composition API...',
      folder: '项目文档',
      tags: ['技术', '前端'],
      createdAt: new Date('2024-03-19T10:20:00'),
      updatedAt: new Date('2024-03-19T10:20:00'),
      wordCount: 800,
      charCount: 4000,
      lineCount: 80,
      filePath: null
    },
    {
      id: 'note6',
      title: '项目计划',
      content: '# 项目计划\n\nQ2项目计划...',
      folder: '工作笔记',
      tags: ['工作', '计划'],
      createdAt: new Date('2024-03-18T09:00:00'),
      updatedAt: new Date('2024-03-18T09:00:00'),
      wordCount: 600,
      charCount: 3000,
      lineCount: 60,
      filePath: null
    },
    {
      id: 'note7',
      title: '前端规范',
      content: '# 前端规范\n\n代码风格、组件设计...',
      folder: '项目文档',
      tags: ['技术', '前端'],
      createdAt: new Date('2024-03-17T16:30:00'),
      updatedAt: new Date('2024-03-17T16:30:00'),
      wordCount: 900,
      charCount: 4500,
      lineCount: 90,
      filePath: null
    },
    {
      id: 'note8',
      title: '读书笔记',
      content: '# 读书笔记\n\n《深入理解计算机系统》...',
      folder: '',
      tags: ['个人'],
      createdAt: new Date('2024-03-15T21:00:00'),
      updatedAt: new Date('2024-03-15T21:00:00'),
      wordCount: 700,
      charCount: 3500,
      lineCount: 70,
      filePath: null
    },
    {
      id: 'note9',
      title: '快速笔记',
      content: '# 快速笔记\n\n随手记下的想法...',
      folder: '',
      tags: ['想法'],
      createdAt: new Date('2024-03-14T14:00:00'),
      updatedAt: new Date('2024-03-14T14:00:00'),
      wordCount: 100,
      charCount: 500,
      lineCount: 10,
      filePath: null
    }
  ]
}
