window.DOCS = {
  "schemaVersion": 1,
  "project": "E2E 冒烟测试文档",
  "pres": {
    "handoff": {
      "repo": ".",
      "mainBranch": "main",
      "branchPrefix": "task/"
    }
  },
  "handoff": {
    "version": "1.1.0",
    "schemaVersion": 1,
    "contracts": {
      "T-1": {
        "hash": "hash-smoke-task-1",
        "effectivePaths": ["e2e/fixtures/fake-agent.mjs"]
      },
      "T-2": {
        "hash": "hash-smoke-task-2",
        "effectivePaths": ["e2e/fixtures/fake-agent.mjs"]
      }
    },
    "readiness": {
      "T-1": {
        "ready": true,
        "contractHash": "hash-smoke-task-1",
        "reasons": []
      },
      "T-2": {
        "ready": true,
        "contractHash": "hash-smoke-task-2",
        "reasons": []
      }
    },
    "effectivePaths": {
      "T-1": ["e2e/fixtures/fake-agent.mjs"],
      "T-2": ["e2e/fixtures/fake-agent.mjs"]
    }
  },
  "data": {
    "tasks": [
      {
        "id": "T-1",
        "title": "冒烟测试第一任务",
        "module": "M1",
        "deps": [],
        "input": "测试输入",
        "output": "测试输出",
        "accept": "1) 验收第一项",
        "est": 1.0,
        "edges": ["E-108"]
      },
      {
        "id": "T-2",
        "title": "冒烟测试第二任务",
        "module": "M1",
        "deps": ["T-1"],
        "input": "测试输入2",
        "output": "测试输出2",
        "accept": "1) 验收第二项",
        "est": 1.0,
        "edges": ["E-31"]
      }
    ]
  },
  "dispatch": {
    "T-1": {
      "contractHash": "hash-smoke-task-1",
      "implementation": "请实现 T-1",
      "review": "请审查 T-1"
    },
    "T-2": {
      "contractHash": "hash-smoke-task-2",
      "implementation": "请实现 T-2",
      "review": "请审查 T-2"
    }
  }
};
