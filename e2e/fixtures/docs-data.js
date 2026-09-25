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
      "SMOKE-T1": {
        "hash": "hash-smoke-task-1",
        "effectivePaths": ["e2e/fixtures/fake-agent.mjs"]
      },
      "SMOKE-T2": {
        "hash": "hash-smoke-task-2",
        "effectivePaths": ["e2e/fixtures/fake-agent.mjs"]
      }
    },
    "readiness": {
      "SMOKE-T1": {
        "ready": true,
        "contractHash": "hash-smoke-task-1",
        "reasons": []
      },
      "SMOKE-T2": {
        "ready": true,
        "contractHash": "hash-smoke-task-2",
        "reasons": []
      }
    },
    "effectivePaths": {
      "SMOKE-T1": ["e2e/fixtures/fake-agent.mjs"],
      "SMOKE-T2": ["e2e/fixtures/fake-agent.mjs"]
    }
  },
  "data": {
    "tasks": [
      {
        "id": "SMOKE-T1",
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
        "id": "SMOKE-T2",
        "title": "冒烟测试第二任务",
        "module": "M1",
        "deps": ["SMOKE-T1"],
        "input": "测试输入2",
        "output": "测试输出2",
        "accept": "1) 验收第二项",
        "est": 1.0,
        "edges": ["E-31"]
      }
    ]
  },
  "dispatch": {
    "SMOKE-T1": {
      "contractHash": "hash-smoke-task-1",
      "implementation": "请实现 SMOKE-T1",
      "review": "请审查 SMOKE-T1"
    },
    "SMOKE-T2": {
      "contractHash": "hash-smoke-task-2",
      "implementation": "请实现 SMOKE-T2",
      "review": "请审查 SMOKE-T2"
    }
  }
};
