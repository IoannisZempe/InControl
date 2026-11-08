"""
InControl Python SDK (Zero Dependencies — uses standard library urllib).

Usage:
    from python_sdk import InControlAgent

    agent = InControlAgent(name="ResearchBot", ide="PyCharm")
    agent.working("Indexing repository", "Parsing 42 Python modules")
    decision = agent.ask_human("Apply automated refactoring to 12 files?", ["Approve", "Skip"])
    print("User chose:", decision["action"], decision.get("text"))
"""

import json
import os
import urllib.request
from typing import List, Optional, Dict, Any


class InControlAgent:
    def __init__(
        self,
        name: str = "Python Agent",
        agent_id: Optional[str] = None,
        ide: str = "Python Runtime",
        workspace: Optional[str] = None,
        branch: str = "main",
        hub_url: Optional[str] = None,
        token: Optional[str] = None,
    ):
        self.hub_url = (hub_url or os.environ.get("INCONTROL_URL", "http://localhost:4747")).rstrip("/")
        # Only needed when the agent runs on a different machine than the hub (`incontrol token`).
        self.token = token or os.environ.get("INCONTROL_TOKEN")
        self.name = name
        self.id = agent_id or f"python-{name.lower().replace(' ', '-')}"
        self.ide = ide
        self.workspace = workspace or os.getcwd()
        self.branch = branch

    def _post(self, path: str, payload: Dict[str, Any], timeout: int = 310) -> Dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(
            f"{self.hub_url}{path}",
            data=data,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def working(self, current_task: str, current_step: str) -> Dict[str, Any]:
        return self._post(
            "/api/agents/event",
            {
                "id": self.id,
                "name": self.name,
                "provider": "custom",
                "ide": self.ide,
                "workspace": self.workspace,
                "branch": self.branch,
                "status": "working",
                "currentTask": current_task,
                "currentStep": current_step,
                "incrementTools": True,
                "logMessage": current_step,
            },
        )

    def needs_attention(self, current_step: str, reason: str = "Ready for review") -> Dict[str, Any]:
        return self._post(
            "/api/agents/event",
            {
                "id": self.id,
                "name": self.name,
                "provider": "custom",
                "ide": self.ide,
                "workspace": self.workspace,
                "branch": self.branch,
                "status": "needs_attention",
                "currentStep": current_step,
                "attentionReason": reason,
                "logMessage": reason,
            },
        )

    def ask_human(
        self,
        question: str,
        options: Optional[List[str]] = None,
        command: Optional[str] = None,
        wait: bool = True,
    ) -> Dict[str, Any]:
        opts = options or ["Approve", "Deny"]
        formatted = [
            {
                "id": label.lower().replace(" ", "_"),
                "label": label,
                "style": "primary" if idx == 0 else ("danger" if idx == len(opts) - 1 else "secondary"),
            }
            for idx, label in enumerate(opts)
        ]
        return self._post(
            "/api/agents/ask",
            {
                "id": self.id,
                "name": self.name,
                "provider": "custom",
                "ide": self.ide,
                "workspace": self.workspace,
                "branch": self.branch,
                "wait": wait,
                "question": question,
                "command": command,
                "options": formatted,
                "allowFreeText": True,
            },
        )
