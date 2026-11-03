"""Stand-in for google.antigravity.types: the names the workers use, shaped as google-antigravity 0.1.22 has them.

The enums carry 0.1.22's members and values; a Step carries the fields the SDK's steps carry, `http_code` included
(0.1.22 puts Google's HTTP status of a failed model request on the error step it yields, the field the SDK itself
reads); the three SDK errors keep their real bases, so AntigravityCancelledError is a BaseException (it derives from
asyncio.CancelledError) and is not caught by `except Exception`. Configuration classes record their keyword
arguments, so a test can read what the worker asked for. Any other configuration name the SDK has resolves to a
recording class too (module __getattr__); a name ending in "Error" resolves to an Exception subclass.
"""
from __future__ import annotations

import asyncio
import copy
import enum


class _Config:
    """A configuration object: keeps its keyword arguments as attributes and in `kwargs`."""

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = dict(kwargs)
        for k, v in kwargs.items():
            setattr(self, k, v)

    def model_dump(self, **_):
        return dict(self.kwargs)

    def __repr__(self):
        return f"{type(self).__name__}({self.kwargs!r})"


class ModelTarget(_Config): pass
class VertexEndpoint(_Config): pass
class GeminiModelOptions(_Config): pass
class CustomSystemInstructions(_Config): pass
class CapabilitiesConfig(_Config): pass
class BudgetConfig(_Config): pass
class RetryConfig(_Config): pass
class ModelAPIRetryConfig(_Config): pass
class ModelOutputRetryConfig(_Config): pass
class CompactionConfig(_Config): pass


class StepType(str, enum.Enum):
    TEXT_RESPONSE = "TEXT_RESPONSE"
    TOOL_CALL = "TOOL_CALL"
    SYSTEM_MESSAGE = "SYSTEM_MESSAGE"
    COMPACTION = "COMPACTION"
    FINISH = "FINISH"
    THINKING = "THINKING"
    UNKNOWN = "UNKNOWN"


class StepSource(str, enum.Enum):
    SYSTEM = "SYSTEM"
    USER = "USER"
    MODEL = "MODEL"
    UNKNOWN = "UNKNOWN"


class StepTarget(str, enum.Enum):
    USER = "TARGET_USER"
    ENVIRONMENT = "TARGET_ENVIRONMENT"
    UNSPECIFIED = "TARGET_UNSPECIFIED"
    UNKNOWN = "UNKNOWN"


class StepStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    DONE = "DONE"
    WAITING_FOR_USER = "WAITING_FOR_USER"
    ERROR = "ERROR"
    CANCELED = "CANCELED"
    UNKNOWN = "UNKNOWN"


class SessionContinuationMode(str, enum.Enum):
    RESUME = "resume"
    CREATE_OR_RESUME = "create_or_resume"
    CREATE_ONLY = "create_only"


class StopReason(str, enum.Enum):
    UNSPECIFIED = "UNSPECIFIED"
    MAX_MODEL_CALLS_EXCEEDED = "MAX_MODEL_CALLS_EXCEEDED"
    MAX_TOOL_CALLS_EXCEEDED = "MAX_TOOL_CALLS_EXCEEDED"
    MAX_INPUT_TOKENS_EXCEEDED = "MAX_INPUT_TOKENS_EXCEEDED"
    MAX_OUTPUT_TOKENS_EXCEEDED = "MAX_OUTPUT_TOKENS_EXCEEDED"
    MAX_TOTAL_TOKENS_EXCEEDED = "MAX_TOTAL_TOKENS_EXCEEDED"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"


class ThinkingLevel(str, enum.Enum):
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ModelType(str, enum.Enum):
    TEXT = "text"
    IMAGE = "image"


class BuiltinTools(str, enum.Enum):
    LIST_DIR = "list_directory"
    SEARCH_DIR = "search_directory"
    FIND_FILE = "find_file"
    VIEW_FILE = "view_file"
    CREATE_FILE = "create_file"
    EDIT_FILE = "edit_file"
    RUN_COMMAND = "run_command"
    FINISH = "finish"


class ServiceTier(str, enum.Enum):
    STANDARD = "standard"
    PRIORITY = "priority"
    FLEX = "flex"


class AntigravityConnectionError(Exception):
    """0.1.22 raises it after yielding an error step whose http_code is 400, 401 or 403."""


class AntigravityCancelledError(asyncio.CancelledError):
    """Raised by a turn that was cancelled with cancel(): a BaseException, as in the SDK."""

    def __init__(self, message: str = "The request was cancelled by the client."):
        super().__init__(message)


class AntigravityExecutionError(Exception):
    """A terminal error of the agent loop ("model unreachable: ...", a 500, a harness that exited non-zero)."""


class AntigravityValidationError(Exception):
    pass


class UsageMetadata:
    """Token usage with the SDK's field names; `+` adds two readings, as the SDK's does."""

    FIELDS = ("prompt_token_count", "cached_content_token_count", "candidates_token_count",
              "thoughts_token_count", "total_token_count")

    def __init__(self, **kw):
        for f in self.FIELDS:
            setattr(self, f, kw.get(f))
        self.service_tier = kw.get("service_tier")

    def __add__(self, other):
        if not isinstance(other, UsageMetadata):
            return NotImplemented
        out = UsageMetadata(**{f: (getattr(self, f) or 0) + (getattr(other, f) or 0) for f in self.FIELDS})
        out.service_tier = self.service_tier if self.service_tier == other.service_tier else (self.service_tier or other.service_tier)
        return out

    def model_copy(self):
        return copy.copy(self)

    def model_dump(self, **_):
        return {**{f: getattr(self, f) for f in self.FIELDS}, "service_tier": self.service_tier}


class ToolCall:
    def __init__(self, name: str, args: dict | None = None, id: str = "", canonical_path: str | None = None):
        self.name, self.args, self.id, self.canonical_path = name, dict(args or {}), id, canonical_path

    def model_dump(self, **_):
        return {"name": self.name, "args": dict(self.args), "id": self.id, "canonical_path": self.canonical_path}


class Step:
    """One step update, as the SDK yields it; every update is a new object appended to the history."""

    def __init__(self, **kw):
        self.id = kw.get("id", "")
        self.step_index = kw.get("step_index", 0)
        self.trajectory_id = kw.get("trajectory_id", "main")
        self.parent_trajectory_id = kw.get("parent_trajectory_id", "")
        self.depth = kw.get("depth", 0)
        self.type = StepType(kw.get("type", "UNKNOWN"))
        self.source = StepSource(kw.get("source", "UNKNOWN"))
        self.target = StepTarget(kw.get("target", "UNKNOWN"))
        self.status = StepStatus(kw.get("status", "UNKNOWN"))
        self.content = kw.get("content", "")
        self.content_delta = kw.get("content_delta", "")
        self.thinking = kw.get("thinking", "")
        self.thinking_delta = kw.get("thinking_delta", "")
        self.tool_calls = [ToolCall(**t) for t in kw.get("tool_calls", [])]
        self.error = kw.get("error", "")
        self.http_code = int(kw.get("http_code", 0))
        self.is_complete_response = kw.get("is_complete_response")
        self.structured_output = kw.get("structured_output")

    def model_dump(self, **_):
        return {k: (v.value if isinstance(v, enum.Enum) else v) for k, v in vars(self).items() if k != "tool_calls"}


class StreamChunk:
    def __init__(self, step_index: int = 0, text: str = ""):
        self.step_index, self.text = step_index, text


class Thought(StreamChunk):
    pass


class Text(StreamChunk):
    pass


class ChatResponse:
    """The turn's chunk stream with a shared buffer, as 0.1.22's ChatResponse: every accessor drains the same stream."""

    def __init__(self, chunk_stream, conversation):
        self._chunk_stream = chunk_stream
        self._conversation = conversation
        self._buffered = []
        self._is_done = False
        self._stream_error = None
        self._pull_lock = asyncio.Lock()

    @property
    def chunks(self):
        async def gen():
            pos = 0
            while True:
                if pos < len(self._buffered):
                    yield self._buffered[pos]
                    pos += 1
                elif self._is_done:
                    if self._stream_error is not None:
                        raise self._stream_error
                    return
                else:
                    async with self._pull_lock:
                        if pos < len(self._buffered) or self._is_done:
                            continue
                        try:
                            chunk = await self._chunk_stream.__anext__()
                        except StopAsyncIteration:
                            self._is_done = True
                        except BaseException as e:  # CancelledError included, as the SDK stores and re-raises it
                            self._is_done = True
                            self._stream_error = e
                            raise
                        else:
                            self._buffered.append(chunk)
        return gen()

    async def __aiter__(self):
        async for c in self.chunks:
            if isinstance(c, Text):
                yield c.text

    @property
    def thoughts(self):
        async def gen():
            async for c in self.chunks:
                if isinstance(c, Thought):
                    yield c.text
        return gen()

    @property
    def tool_calls(self):
        async def gen():
            async for c in self.chunks:
                if isinstance(c, ToolCall):
                    yield c
        return gen()

    async def resolve(self):
        return [c async for c in self.chunks]

    async def text(self):
        chunks = await self.resolve()
        return "".join(c.text for c in chunks if isinstance(c, Text))

    async def structured_output(self):
        if not self._is_done:
            await self.resolve()
        return self._conversation.get_last_structured_output()

    @property
    def usage_metadata(self):
        return self._conversation.last_turn_usage

    @property
    def stop_reason(self):
        return getattr(self._conversation, "_last_turn_stop_reason", StopReason.UNSPECIFIED)

    async def cancel(self):
        if not self._is_done:
            await self._conversation.cancel()


def __getattr__(name: str):
    # A name this stand-in does not spell out: an error class for "...Error", else a recording configuration class.
    if name.startswith("__"):
        raise AttributeError(name)
    cls = type(name, (Exception,), {}) if name.endswith("Error") else type(name, (_Config,), {})
    globals()[name] = cls
    return cls
