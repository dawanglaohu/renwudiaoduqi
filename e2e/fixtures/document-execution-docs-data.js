window.DOCS = {
	"schemaVersion": 1,
	"project": "文档顺序自动执行验收",
	"pres": { "handoff": { "repo": ".", "mainBranch": "main", "branchPrefix": "task/" } },
	"handoff": {
		"version": "1.1.0",
		"schemaVersion": 1,
		"contracts": {
			"DE-B1-A": { "hash": "hash-de-b1-a", "effectivePaths": ["src/de-b1-a.ts"] },
			"DE-B1-B": { "hash": "hash-de-b1-b", "effectivePaths": ["src/de-b1-b.ts"] },
			"DE-B1-C": { "hash": "hash-de-b1-c", "effectivePaths": ["src/de-b1-c.ts"] },
			"DE-B2-A": { "hash": "hash-de-b2-a", "effectivePaths": ["src/de-b2-a.ts"] },
			"DE-B3-A": { "hash": "hash-de-b3-a", "effectivePaths": ["src/de-b3-a.ts"] }
		},
		"readiness": {
			"DE-B1-A": { "ready": true, "contractHash": "hash-de-b1-a", "reasons": [] },
			"DE-B1-B": { "ready": true, "contractHash": "hash-de-b1-b", "reasons": [] },
			"DE-B1-C": { "ready": true, "contractHash": "hash-de-b1-c", "reasons": [] },
			"DE-B2-A": { "ready": true, "contractHash": "hash-de-b2-a", "reasons": [] },
			"DE-B3-A": { "ready": true, "contractHash": "hash-de-b3-a", "reasons": [] }
		},
		"effectivePaths": {
			"DE-B1-A": ["src/de-b1-a.ts"],
			"DE-B1-B": ["src/de-b1-b.ts"],
			"DE-B1-C": ["src/de-b1-c.ts"],
			"DE-B2-A": ["src/de-b2-a.ts"],
			"DE-B3-A": ["src/de-b3-a.ts"]
		}
	},
	"data": {
		"tasks": [
			{ "id": "DE-B1-A", "title": "第一批甲", "module": "M1", "deps": [], "accept": "1) 甲落地", "est": 1 },
			{ "id": "DE-B1-B", "title": "第一批乙", "module": "M1", "deps": [], "accept": "1) 乙落地", "est": 1 },
			{ "id": "DE-B1-C", "title": "第一批丙", "module": "M1", "deps": [], "accept": "1) 丙排队后补位", "est": 1 },
			{ "id": "DE-B2-A", "title": "第二批", "module": "M1", "deps": ["DE-B1-A", "DE-B1-B", "DE-B1-C"], "accept": "1) 收口后自动开始", "est": 1 },
			{ "id": "DE-B3-A", "title": "第三批", "module": "M1", "deps": ["DE-B2-A"], "accept": "1) 继续后才派发", "est": 1 }
		]
	},
	"dispatch": {
		"DE-B1-A": { "contractHash": "hash-de-b1-a", "implementation": "DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: DE-B1-A\n实现第一批甲", "review": "DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: DE-B1-A\n审查第一批甲" },
		"DE-B1-B": { "contractHash": "hash-de-b1-b", "implementation": "DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: DE-B1-B\n实现第一批乙", "review": "DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: DE-B1-B\n审查第一批乙" },
		"DE-B1-C": { "contractHash": "hash-de-b1-c", "implementation": "DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: DE-B1-C\n实现第一批丙", "review": "DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: DE-B1-C\n审查第一批丙" },
		"DE-B2-A": { "contractHash": "hash-de-b2-a", "implementation": "DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: DE-B2-A\n实现第二批", "review": "DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: DE-B2-A\n审查第二批" },
		"DE-B3-A": { "contractHash": "hash-de-b3-a", "implementation": "DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: DE-B3-A\n实现第三批", "review": "DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: DE-B3-A\n审查第三批" }
	}
};
