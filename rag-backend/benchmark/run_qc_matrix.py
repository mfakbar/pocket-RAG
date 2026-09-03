from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine, _broad_query


TEMPLATES = [
    ("executive-summary", "Executive summary", "Summarize the most important points, decisions, risks, and next steps."),
    ("find-answer", "Find a clear answer", "What are the clearest answers or conclusions supported by the selected files? Explain them clearly, cite the evidence, and say when important details are missing."),
    ("compare-options", "Compare options", "First find one selected file that clearly presents two or more options as alternatives, then compare only those options. Use one short section per option and cover supported benefits, drawbacks, costs, and key differences. If no single file supports a like-for-like comparison, do not compare or summarize unrelated files; briefly say so and ask me to choose a specific file, project, or topic."),
    ("action-plan", "Create an action plan", "Create a practical action plan only when the selected files support one clear project or objective. Include priorities and next steps, and include owners or deadlines only when the files explicitly name them. If the files cover unrelated projects and no single objective is clear, do not combine them into one plan; briefly say so and ask me to choose a specific file, project, or objective."),
    ("risks-gaps", "Find risks and gaps", "Identify the main risks, missing information, assumptions, and questions that still need answers."),
    ("meeting-brief", "Prepare a meeting brief", "Prepare a concise meeting brief with background, key facts, likely questions, and recommended talking points."),
    ("timeline", "Build a timeline", "Create a chronological timeline using only events, decisions, and deadlines explicitly dated in the selected files. List undated items separately."),
    ("extract-numbers", "Extract key numbers", "List the important numbers, costs, dates, targets, and measurements. Explain what each one means."),
    ("plain-language", "Explain simply", "Explain the relevant information in plain language for someone who is new to the topic."),
    ("draft-from-files", "Draft from my files", "Draft a clear, professional response using only facts in the selected files. Keep unrelated customers, projects, or files in separate sections, do not combine their numbers, and flag anything that needs confirmation."),
]

CITATION = re.compile(r"\[(\d+)\]")
HTML = re.compile(r"</?(?:br|p|div|span|li|ul|ol|table|tr|td|h[1-6])\b", re.I)
RAW_TABLE = re.compile(r"^\s*\|.+\|\s*$", re.M)
QUERY_OPENING = re.compile(
    r"^(?:please\s+)?(?:what|which|how|why|when|where|who|compare|analy[sz]e|identify|explain|evaluate|assess|review|find|outline|summari[sz]e|draft|prepare|create|using|based on)\b",
    re.I,
)
META_PROMPT = re.compile(
    r"\b(?:rewrite|your task|you are|respond with|return only|system prompt|original intent|"
    r"insert original|guidelines|descriptions and instructions)\b|\[(?:insert|original)[^\]]*\]",
    re.I,
)
ANSWER_LIKE = re.compile(r"\b(?:the answer is|the documents (?:show|state|confirm)|in summary)\b", re.I)
CONSTRAINTS = re.compile(r"\b(?:owner|responsible|deadline|\d+\s+(?:day|week|month|quarter|year)s?)\b", re.I)
INTENTS = [
    (re.compile(r"\bcompar(?:e|ison|ing)\b", re.I), re.compile(r"\bcompar(?:e|ison|ing)\b", re.I)),
    (re.compile(r"\bsummari[sz](?:e|ing|ation)\b", re.I), re.compile(r"\bsummari[sz](?:e|ing|ation)\b", re.I)),
    (re.compile(r"\bexplain\b", re.I), re.compile(r"\bexplain\b", re.I)),
    (re.compile(r"\bdraft\b", re.I), re.compile(r"\bdraft\b", re.I)),
    (re.compile(r"\btimeline\b", re.I), re.compile(r"\b(?:timeline|chronological)\b", re.I)),
]
STOP_WORDS = {
    "about", "also", "and", "are", "available", "based", "files", "for", "from",
    "into", "local", "most", "of", "on", "relevant", "selected", "that", "the",
    "these", "this", "using", "what", "which", "with",
}
NUMERIC_CLAIM = re.compile(
    r"(?<![a-z0-9])(?:(?:\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?)|"
    r"(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"(?:\s*(?:%|bps|kbps|mbps|gbps|tbps|w|watts?|kw|kilowatts?|mw|megawatts?|"
    r"gw|wh|kwh|mwh|v|volts?|kv|a|amps?|amperes?|ma|gb|gigabytes?|tb|mb|kb|"
    r"bytes?|days?|weeks?|months?|years?|hours?|minutes?|seconds?|racks?|nodes?|"
    r"servers?|ports?|cores?|threads?|gpus?|cpus?|units?|usd|idr))?)(?![a-z0-9])",
    re.I,
)
NUMERIC_VALUE = re.compile(
    r"\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?|"
    r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
)


@dataclass
class OllamaResult:
    content: str
    elapsed_ms: float
    done_reason: str


def ollama_chat(
    url: str,
    model: str,
    messages: list[dict[str, str]],
    *,
    context: int,
    temperature: float,
    top_p: float,
    max_tokens: int,
    timeout: int = 900,
    json_mode: bool | dict[str, Any] = False,
    allow_continuation: bool = True,
) -> OllamaResult:
    started = time.perf_counter()
    generated = ""
    done_reason = ""
    request_messages = messages
    maximum_total_tokens = min(2048, max(768, max_tokens + min(1024, max_tokens)))
    completion_tokens = 0
    for attempt in range(3):
        remaining_tokens = max(1, maximum_total_tokens - completion_tokens)
        payload = json.dumps(
            {
                "model": model,
                "messages": request_messages,
                "stream": False,
                "think": False,
                **({"format": json_mode if isinstance(json_mode, dict) else "json"} if json_mode else {}),
                "options": {
                    "num_ctx": context,
                    "temperature": temperature,
                    "top_p": top_p,
                    "num_predict": min(max_tokens, remaining_tokens),
                },
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{url.rstrip('/')}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        body: dict[str, Any] | None = None
        last_error: Exception | None = None
        for request_attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    body = json.loads(response.read().decode("utf-8"))
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
                last_error = error
                if request_attempt < 2 and (
                    not isinstance(error, urllib.error.HTTPError) or error.code >= 500
                ):
                    time.sleep(request_attempt + 1)
                    continue
                break
        if body is None:
            raise RuntimeError(f"Local model request failed after 3 attempts: {last_error}") from last_error
        content = str(body.get("message", {}).get("content", ""))
        generated += content
        completion_tokens += int(body.get("eval_count") or max(1, len(content) // 4))
        done_reason = str(body.get("done_reason", ""))
        if (
            not allow_continuation
            or done_reason != "length"
            or attempt == 2
            or completion_tokens >= maximum_total_tokens
            or not generated.strip()
        ):
            break
        request_messages = [
            *messages,
            {"role": "assistant", "content": generated},
            {
                "role": "user",
                "content": "Continue exactly where the answer stopped. Do not repeat anything or start a new section unless it is required to finish the current answer. Prioritize completing the remaining points and end with a complete sentence using the same Markdown style.",
            },
        ]
    return OllamaResult(
        content=generated.strip(),
        elapsed_ms=(time.perf_counter() - started) * 1000,
        done_reason=done_reason,
    )


def unload_model(url: str, model: str) -> None:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/api/generate",
        data=json.dumps({"model": model, "keep_alive": 0, "stream": False}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60):
            pass
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        pass


def clean_model_text(value: str) -> str:
    value = re.sub(r"<think>[\s\S]*?</think>", "", value, flags=re.I)
    value = re.sub(r"^```(?:markdown|text)?\s*|\s*```$", "", value.strip(), flags=re.I)
    value = re.sub(r"\[\[(\d+)\]\]", r"[\1]", value)
    return value.strip().strip('"').strip()


def normalize_model_html(value: str) -> str:
    value = re.sub(r"&nbsp;", " ", value, flags=re.I)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(
        r"</?(?:p|div|section|article|header|footer|ul|ol|blockquote|table|thead|tbody|tr|h[1-6])(?:\s[^>]*)?>",
        "\n",
        value,
        flags=re.I,
    )
    value = re.sub(r"<li(?:\s[^>]*)?>", "- ", value, flags=re.I)
    value = re.sub(r"</li>", "\n", value, flags=re.I)
    value = re.sub(r"<strong(?:\s[^>]*)?>|</strong>", "**", value, flags=re.I)
    value = re.sub(r"<em(?:\s[^>]*)?>|</em>", "*", value, flags=re.I)
    value = re.sub(r"<code(?:\s[^>]*)?>|</code>", "`", value, flags=re.I)
    value = re.sub(r"</?(?:span|a)(?:\s[^>]*)?>", "", value, flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def prompt_only(value: str) -> bool:
    prompt = value.strip()
    if len(prompt) < 8 or len(prompt) > 700 or "\n" in prompt:
        return False
    if re.search(r"\||\*\*|`|\[\d+\]|</?[a-z][^>]*>", prompt, re.I):
        return False
    if re.search(r"^(?:[-*]|\d+\.)\s", prompt, re.M):
        return False
    return bool(QUERY_OPENING.search(prompt))


def semantic_prompt_safe(original: str, enhanced: str, base: dict[str, Any]) -> bool:
    if not prompt_only(enhanced) or META_PROMPT.search(enhanced) or ANSWER_LIKE.search(enhanced):
        return False
    context = f"{original} {base['name']}"
    allowed_acronyms = {item.lower() for item in re.findall(r"\b([A-Z][A-Z0-9-]{1,})\b", context)}
    enhanced_acronyms = {item.lower() for item in re.findall(r"\b([A-Z][A-Z0-9-]{1,})\b", enhanced)}
    if enhanced_acronyms - allowed_acronyms:
        return False
    for acronym in re.findall(r"\b([A-Z][A-Z0-9-]{1,})\b", original):
        if re.search(rf"\b{re.escape(acronym)}\s*\(", enhanced, re.I):
            return False
    allowed_numbers = set(re.findall(r"\b\d+(?:[.,]\d+)?\b", context))
    if set(re.findall(r"\b\d+(?:[.,]\d+)?\b", enhanced)) - allowed_numbers:
        return False
    if not CONSTRAINTS.search(original) and CONSTRAINTS.search(enhanced):
        return False
    for original_intent, required_intent in INTENTS:
        if original_intent.search(original) and not required_intent.search(enhanced):
            return False
    original_terms = {
        item for item in re.findall(r"[a-z0-9][a-z0-9._/-]*", original.lower())
        if len(item) >= 3 and item not in STOP_WORDS
    }
    enhanced_terms = set(re.findall(r"[a-z0-9][a-z0-9._/-]*", enhanced.lower()))
    return not original_terms or len(original_terms & enhanced_terms) / len(original_terms) >= 0.6


def fallback_improvement(prompt: str, base: dict[str, Any]) -> str:
    original = re.sub(r"\s+", " ", prompt).strip()
    if len(original) >= 120 and re.search(
        r"\b(?:do not|only when|use only|otherwise|until i choose)\b", original, re.I
    ):
        return original
    prefix = "" if str(base["name"]).lower() in original.lower() else f"Using the {base['name']} knowledge base, "
    return (
        f"{prefix}{original} Use only relevant file content, "
        "cite supporting passages, and state clearly when the files do not contain enough information."
    )


def improve_prompt(
    url: str,
    model: str,
    prompt: str,
    base: dict[str, Any],
) -> tuple[str, float, bool]:
    guidance = f"{base['name']}: {base.get('description') or 'Local documents'}"
    if base.get("customInstructions"):
        guidance += f"\nInstructions: {base['customInstructions']}"
    result = ollama_chat(
        url,
        model,
        [
            {
                "role": "system",
                "content": (
                    "Rewrite the user question into one stronger prompt for a private local document "
                    "assistant. Use the selected knowledge base titles, descriptions, and instructions "
                    "only to make the question more focused, specific, and useful for finding insights. "
                    "Preserve the original intent, action, topic, acronyms, numbers, quoted text, and scope. "
                    "Never expand an acronym. Do not add facts, document names, people, owners, dates, "
                    "deadlines, constraints, output requirements, or conclusions that are absent from the "
                    "original question. "
                    "Return exactly one enhanced prompt and nothing else. Do not answer the question, "
                    "summarize documents, write a meta-prompt, explain your changes, add a heading, or use "
                    "HTML or Markdown."
                ),
            },
            {
                "role": "user",
                "content": f"Knowledge bases:\n{guidance}\n\nOriginal prompt:\n{prompt.strip()}",
            },
        ],
        context=4096,
        temperature=0.1,
        top_p=0.9,
        max_tokens=256,
    )
    enhanced = clean_model_text(result.content)
    valid = semantic_prompt_safe(prompt, enhanced, base)
    return (enhanced if valid else fallback_improvement(prompt, base), result.elapsed_ms, valid)


def select_chunks(
    chunks: list[dict[str, Any]], context_length: int, broad_query: bool = False
) -> list[dict[str, Any]]:
    budget = int(context_length * 3.2 * (0.58 if broad_query else 0.48))
    selected: list[dict[str, Any]] = []
    used = 0
    for chunk in chunks:
        cost = len(chunk["text"]) + len(chunk["file"]) + len(chunk["location"]) + 48
        if selected and used + cost > budget:
            break
        selected.append(chunk)
        used += cost
    return selected


def source_text(chunks: list[dict[str, Any]], base: dict[str, Any]) -> str:
    blocks = []
    for index, chunk in enumerate(chunks, 1):
        title = re.sub(r"[_-]+", " ", Path(str(chunk["file"])).stem).strip()
        fields = [
            f"[{index}]",
            f"Document title: {title or chunk['file']}",
            f"Knowledge base: {base['name']}",
            f"File: {chunk['file']}",
            f"Location: {chunk['location']}",
        ]
        if chunk.get("heading"):
            fields.append(f"Section: {chunk['heading']}")
        fields.extend(["Content:", str(chunk["text"]).strip()])
        blocks.append("\n".join(fields))
    return "\n\n".join(blocks)


def answer_prompt(base: dict[str, Any], chunks: list[dict[str, Any]]) -> str:
    guidance = f"Knowledge base: {base['name']}"
    if base.get("description"):
        guidance += f"\nDescription: {base['description']}"
    if base.get("customInstructions"):
        guidance += f"\nInstructions: {base['customInstructions']}"
    return (
        "You are RavenDock. Use only the supplied local sources; never add general knowledge or infer "
        "missing facts. Use document titles and sections as context.\n\n"
        "RESPONSE\n"
        "- Start with a direct, clear answer. Use concise Markdown headings and short bullets.\n"
        "- For comparisons, give each option its own heading and cover only supported differences, "
        "trade-offs, costs, and timing. Never use Markdown tables, raw pipes, or HTML.\n"
        "- Cite every factual paragraph and bullet inline as [1], [2], and so on. Cite statements about "
        "missing information with the most relevant source.\n"
        "- Copy every number and unit exactly from its cited source. Never shorten, round, combine, "
        "calculate, or relabel values. Keep each value attached to the correct item.\n"
        "- Unless the user requests otherwise, keep the answer under 450 words with no more than six "
        "sections. Finish every answer with a complete sentence.\n\n"
        "GROUNDING\n"
        "- If one file is named, use only that file unless the user explicitly requests a comparison.\n"
        "- Keep unrelated files, customers, configurations, prices, and dates separate.\n"
        "- State clearly when requested information is absent. Do not explain terms or expand acronyms "
        "unless a source provides the definition.\n"
        "- Treat speaker names, dates, copyright lines, and slide footers as metadata unless requested.\n"
        "- Add recommendations, decisions, owners, next steps, savings, ROI, superiority claims, or "
        "calculations only when explicitly supported and requested.\n"
        "- Never invent a draft, repeat content, or repeat headings."
        "\n\nKNOWLEDGE BASE GUIDANCE\n"
        + guidance
        + "\n\nLOCAL SOURCES\n"
        + source_text(chunks, base)
    )


def grounding_issues(answer: str, chunks: list[dict[str, Any]]) -> list[str]:
    issues: set[str] = set()
    normalized = answer.strip()
    if not normalized:
        return ["empty answer"]
    if HTML.search(normalized):
        issues.add("raw HTML")
    if RAW_TABLE.search(normalized):
        issues.add("raw Markdown table")
    final_line = normalized.rsplit("\n", 1)[-1].strip()
    if (
        normalized[-1] in "|,:;({-"
        or normalized.count("```") % 2
        or re.search(r"\b(?:and|or|to|with|by|for|because|including|such as)\s*[.!?]*$", final_line, re.I)
    ):
        issues.add("incomplete ending")
    normalized_words = re.findall(
        r"[a-z0-9][a-z0-9._/-]*",
        re.sub(r"\[\d+\]|[*_`#>|]", " ", normalized.lower()),
    )
    seen_phrases: set[str] = set()
    for index in range(max(0, len(normalized_words) - 11)):
        phrase = " ".join(normalized_words[index : index + 12])
        if phrase in seen_phrases:
            issues.add("repeated content")
            break
        seen_phrases.add(phrase)
    labels = [
        re.sub(r"[*_`:#]+", "", item).strip().lower()
        for item in re.findall(r"^#{1,6}\s+(.+)$", normalized, re.M)
        if item
    ]
    if any(label and labels.index(label) != index for index, label in enumerate(labels)):
        issues.add("repeated content")
    referenced = [int(item) for item in CITATION.findall(normalized)]
    if not referenced:
        issues.add("missing citations")
    if any(item < 1 or item > len(chunks) for item in referenced):
        issues.add("invalid citation number")
    source_text_value = re.sub(
        r"[^a-z0-9]+", " ", "\n".join(str(chunk["text"]) for chunk in chunks).lower()
    )
    for match in re.finditer(r"\b([A-Za-z][A-Za-z -]{3,60})\s+\(([A-Z][A-Z0-9-]{1,})\)", normalized):
        words = re.findall(r"[A-Za-z]+", match.group(1))
        target = re.sub(r"[^A-Z0-9]", "", match.group(2))
        expansion = ""
        for size in range(2, min(6, len(words)) + 1):
            candidate = words[-size:]
            if "".join(word[0].upper() for word in candidate) == target:
                expansion = " ".join(candidate).lower()
                break
        if expansion and expansion not in source_text_value:
            issues.add("unsupported acronym expansion")
    paragraphs = [
        block
        for paragraph in re.split(r"\n\s*\n", normalized)
        for block in re.split(r"\n(?=\s*(?:[-*]|\d+\.|#{1,6})\s)", paragraph)
        if block.strip()
    ]
    inherited_list_refs: list[int] = []
    for paragraph in paragraphs:
        words = {
            item for item in re.findall(r"[a-z0-9][a-z0-9._/-]*", CITATION.sub(" ", paragraph).lower())
            if len(item) >= 3 and item not in STOP_WORDS
        }
        plain = re.sub(r"^\s*(?:#{1,6}|[-*]|\d+[.)])\s+", "", paragraph).strip()
        paragraph_refs = [
            item
            for item in (int(value) for value in CITATION.findall(paragraph))
            if 1 <= item <= len(chunks)
        ]
        is_bullet = bool(re.match(r"^\s*(?:[-*]|\d+\.)\s", paragraph))
        if (
            len(words) < 6
            or re.match(r"^\s*#{1,6}\s", paragraph)
            or re.match(r"^based on (?:the )?(?:provided|selected|local) (?:files|sources)", plain, re.I)
            or plain.endswith("?")
            or plain.endswith(":")
        ):
            if plain.endswith(":"):
                inherited_list_refs = paragraph_refs
            continue
        refs = paragraph_refs or (inherited_list_refs if is_bullet else [])
        if not is_bullet:
            inherited_list_refs = []
        if not refs:
            issues.add("uncited factual paragraph")
            continue
        if re.search(
            r"\b(?:do not|does not|did not|not)\s+(?:contain|provide|include|state|specify|show)\b|"
            r"\b(?:absent|missing information)\b",
            plain,
            re.I,
        ):
            continue
        source_words = {
            item
            for ref in refs
            for item in re.findall(r"[a-z0-9][a-z0-9._/-]*", str(chunks[ref - 1]["text"]).lower())
            if len(item) >= 3 and item not in STOP_WORDS
        }
        shared = len(words & source_words)
        if shared < 2 and shared / len(words) < 0.08:
            issues.add("citation lacks passage support")
        for claim in numeric_claims(plain):
            if not any(
                source_supports_numeric_claim(str(chunk["text"]), claim) for chunk in chunks
            ):
                issues.add(f"unsupported numeric claim: {claim['display']}")
    return sorted(issues)


def numeric_claims(value: str) -> list[dict[str, Any]]:
    value = re.sub(r"\[\d+(?:\s*,\s*\d+)*\]", " ", value)
    value = re.sub(r"^\s*(?:[-*]|\d+[.)])\s+", "", value, flags=re.M)
    claims: list[dict[str, Any]] = []
    for match in NUMERIC_CLAIM.finditer(value):
        display = match.group(0).strip()
        number = re.search(
            r"\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?|"
            r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?",
            display,
        )
        unit = re.search(r"([a-z%]+)\s*$", display, re.I)
        normalized_number = (number.group(0) if number else "").replace(",", "")
        normalized_number = re.sub(r"^0+(?=\d)", "", normalized_number) or "0"
        is_ip_address = bool(
            re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?", display)
        )
        if "." in normalized_number and normalized_number.count(".") == 1:
            normalized_number = normalized_number.rstrip("0").rstrip(".")
        normalized_unit = unit.group(1).lower() if unit else None
        if normalized_unit and normalized_unit.endswith("s"):
            normalized_unit = normalized_unit[:-1]
        aliases = {
            "w": "watt",
            "watt": "watt",
            "kw": "kilowatt",
            "kilowatt": "kilowatt",
            "mw": "megawatt",
            "megawatt": "megawatt",
            "v": "volt",
            "volt": "volt",
            "a": "ampere",
            "amp": "ampere",
            "ampere": "ampere",
            "gb": "gigabyte",
            "gigabyte": "gigabyte",
        }
        normalized_unit = "ip-address" if is_ip_address else aliases.get(normalized_unit, normalized_unit)
        claims.append(
            {
                "display": display,
                "value": normalized_number,
                "unit": normalized_unit,
                "currency": bool(re.match(r"[$€£]", display) or re.search(r"\b(?:usd|idr)\b", display, re.I)),
            }
        )
    return claims


def source_supports_numeric_claim(source: str, claim: dict[str, Any]) -> bool:
    for match in NUMERIC_VALUE.finditer(source):
        source_value = match.group(0).replace(",", "")
        source_value = re.sub(r"^0+(?=\d)", "", source_value) or "0"
        if "." in source_value and source_value.count(".") == 1:
            source_value = source_value.rstrip("0").rstrip(".")
        if source_value != claim["value"]:
            continue
        nearby = source[max(0, match.start() - 16) : match.end() + 24].lower()
        unit = claim["unit"]
        if unit and unit not in {"usd", "idr", "ip-address", "unit"}:
            aliases = {
                "watt": ["w", "watt", "watts"],
                "kilowatt": ["kw", "kilowatt", "kilowatts"],
                "megawatt": ["mw", "megawatt", "megawatts"],
                "volt": ["v", "volt", "volts"],
                "ampere": ["a", "amp", "amps", "ampere", "amperes"],
                "gigabyte": ["gb", "gigabyte", "gigabytes"],
            }
            unit_forms = aliases.get(unit, [unit, f"{unit}s"])
            unit_found = "%" in nearby if unit == "%" else any(
                re.search(rf"(?<![a-z]){re.escape(form)}\b", nearby, re.I)
                for form in unit_forms
            )
            if not unit_found:
                continue
        return True
    return False


def repair_instruction(issues: list[str]) -> str:
    return (
        "Write a fresh, complete final answer to the original user request. Fix these quality problems: "
        + ", ".join(issues)
        + ". Start again from the supplied local sources; do not quote, discuss, or preserve the previous "
        "draft. Remove every unsupported claim. Cite every factual paragraph and bullet with valid source "
        "numbers. Do not repeat text, headings, or list labels. Do not use a Markdown table, raw pipe "
        "characters, HTML, or commentary about the rewrite. Do not expand acronyms or explain technical "
        "terms unless a source explicitly provides the definition. Copy every number and unit exactly "
        "from its cited source; never shorten, round, combine, calculate, or relabel values. Keep each "
        "value attached to the correct item. Keep the answer under 600 words with "
        "no more than six sections, and end with a complete sentence."
    )


def sanitize_answer(answer: str, chunks: list[dict[str, Any]]) -> str:
    answer = normalize_model_html(answer)
    lines = answer.splitlines()
    without_tables: list[str] = []
    index = 0
    while index < len(lines):
        header = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
        separator = (
            [cell.strip() for cell in lines[index + 1].strip().strip("|").split("|")]
            if index + 1 < len(lines)
            else []
        )
        is_table = (
            len(header) > 1
            and len(separator) == len(header)
            and all(re.fullmatch(r":?-{3,}:?", cell) for cell in separator)
        )
        if not is_table:
            without_tables.append(lines[index])
            index += 1
            continue
        index += 2
        while index < len(lines) and re.fullmatch(r"\s*\|.*\|\s*", lines[index]):
            cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
            fields = [
                f"**{label}:** {cells[cell_index]}"
                for cell_index, label in enumerate(header)
                if cell_index < len(cells) and cells[cell_index]
            ]
            if fields:
                without_tables.append("- " + "; ".join(fields))
            index += 1
    answer = "\n".join(without_tables)
    source_value = re.sub(
        r"[^a-z0-9]+", " ", "\n".join(str(chunk["text"]) for chunk in chunks).lower()
    )

    def replace_expansion(match: re.Match[str]) -> str:
        lead, acronym = match.group(1), match.group(2)
        words = re.findall(r"[A-Za-z]+", lead)
        target = re.sub(r"[^A-Z0-9]", "", acronym)
        for size in range(2, min(6, len(words)) + 1):
            candidate = words[-size:]
            if "".join(word[0].upper() for word in candidate) != target:
                continue
            expansion = " ".join(candidate)
            normalized = re.sub(r"[^a-z0-9]+", " ", expansion.lower())
            if normalized not in source_value:
                return lead[: -len(expansion)] + acronym
            break
        return match.group(0)

    cleaned = re.sub(
        r"\b([A-Za-z][A-Za-z -]{3,60})\s+\(([A-Z][A-Z0-9-]{1,})\)",
        replace_expansion,
        answer,
    )
    seen_phrases: set[str] = set()
    deduplicated_lines: list[str] = []
    for line in cleaned.splitlines():
        if re.match(r"^\s*#{1,6}\s", line):
            deduplicated_lines.append(line)
            continue
        kept: list[str] = []
        for segment in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9*])", line):
            words = re.findall(
                r"[a-z0-9][a-z0-9._/-]*",
                re.sub(r"\[\d+\]|[*_`#>|]", " ", segment.lower()),
            )
            phrases = {
                " ".join(words[index : index + 12])
                for index in range(max(0, len(words) - 11))
            }
            if phrases and any(phrase in seen_phrases for phrase in phrases):
                continue
            seen_phrases.update(phrases)
            kept.append(segment)
        deduplicated_lines.append(" ".join(kept))
    cleaned = "\n".join(deduplicated_lines)
    seen: set[str] = set()
    blocks: list[str] = []
    for block in re.split(r"(\n\s*\n)", cleaned):
        if re.fullmatch(r"\n\s*\n", block):
            blocks.append(block)
            continue
        normalized = re.sub(r"\s+", " ", block).strip().lower()
        if len(normalized) >= 60 and normalized in seen:
            continue
        if len(normalized) >= 60:
            seen.add(normalized)
        blocks.append(block)
    return re.sub(r"\n{3,}", "\n\n", "".join(blocks)).strip()


def attach_supported_citations(answer: str, chunks: list[dict[str, Any]]) -> str:
    source_terms = [
        {
            item
            for item in re.findall(r"[a-z0-9][a-z0-9._/-]*", str(chunk["text"]).lower())
            if len(item) >= 3 and item not in STOP_WORDS
        }
        for chunk in chunks
    ]
    lines: list[str] = []
    for line in answer.splitlines():
        plain = re.sub(r"^\s*(?:#{1,6}|[-*]|\d+\.)\s+", "", line).strip()
        terms = {
            item
            for item in re.findall(r"[a-z0-9][a-z0-9._/-]*", CITATION.sub(" ", plain).lower())
            if len(item) >= 3 and item not in STOP_WORDS
        }
        if (
            CITATION.search(line)
            or len(terms) < 6
            or re.match(r"^\s*#{1,6}\s", line)
            or plain.endswith("?")
            or plain.endswith(":")
        ):
            lines.append(line)
            continue
        overlaps = [len(terms & candidate) for candidate in source_terms]
        best = max(range(len(overlaps)), key=overlaps.__getitem__) if overlaps else -1
        lines.append(
            f"{line.rstrip()} [{best + 1}]"
        if best >= 0 and (overlaps[best] >= 2 or overlaps[best] / len(terms) >= 0.08)
            else line
        )
    return "\n".join(lines)


def grounded_fallback(chunks: list[dict[str, Any]]) -> str:
    entries = [
        "## I could not verify a complete answer",
        "",
        "I found relevant local sections, but I could not create a reliable answer without risking "
        "unsupported details. Try a narrower question or another model.",
        "",
        "### Relevant local sections",
        "",
    ]
    for index, chunk in enumerate(chunks[:5], 1):
        entries.append(f"- **{chunk['file']}** - {chunk['location']} [{index}]")
    return "\n".join(entries)


def run_answer(
    engine: RagEngine,
    url: str,
    model: str,
    base: dict[str, Any],
    prompt: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    started = time.perf_counter()
    response = engine.query(
        {
            "query": prompt,
            "knowledgeBaseIds": [str(base["id"])],
            "settings": config.get("rag", {}),
        }
    )
    retrieval_ms = (time.perf_counter() - started) * 1000
    chunks = select_chunks(
        response["chunks"],
        int(config["inference"]["contextLength"]),
        _broad_query(prompt),
    )
    if not chunks:
        return {
            "answer": "",
            "chunks": [],
            "retrievalMs": retrieval_ms,
            "answerMs": 0.0,
            "doneReason": "no_results",
        }
    inference = config["inference"]
    messages = [
        {"role": "system", "content": answer_prompt(base, chunks)},
        {"role": "user", "content": prompt},
    ]
    result = ollama_chat(
        url,
        model,
        messages,
        context=int(inference["contextLength"]),
        temperature=float(inference["temperature"]),
        top_p=float(inference["topP"]),
        max_tokens=int(inference["maxOutputTokens"]),
    )
    answer = attach_supported_citations(
        sanitize_answer(clean_model_text(result.content), chunks), chunks
    )
    issues = grounding_issues(answer, chunks)
    repair_ms = 0.0
    for _repair_attempt in range(1):
        if not issues:
            break
        repaired = ollama_chat(
            url,
            model,
            [
                *messages,
                {"role": "user", "content": repair_instruction(issues)},
            ],
            context=int(inference["contextLength"]),
            temperature=0.0,
            top_p=min(float(inference["topP"]), 0.8),
            max_tokens=min(int(inference["maxOutputTokens"]), 768 if _broad_query(prompt) else 512),
            allow_continuation=True,
        )
        answer = attach_supported_citations(
            sanitize_answer(clean_model_text(repaired.content), chunks), chunks
        )
        repair_ms += repaired.elapsed_ms
        result = OllamaResult(
            content=answer,
            elapsed_ms=result.elapsed_ms + repaired.elapsed_ms,
            done_reason=repaired.done_reason,
        )
        issues = grounding_issues(answer, chunks)
    if issues:
        answer = grounded_fallback(chunks)
        issues = []
    return {
        "answer": answer,
        "chunks": chunks,
        "retrievalMs": retrieval_ms,
        "answerMs": result.elapsed_ms,
        "repairMs": repair_ms,
        "qualityIssues": issues,
        "doneReason": result.done_reason,
    }


def deterministic_checks(answer: str, chunks: list[dict[str, Any]]) -> dict[str, Any]:
    citations = [int(item) for item in CITATION.findall(answer)]
    return {
        "empty": not bool(answer.strip()),
        "containsHtml": bool(HTML.search(answer)),
        "containsRawTable": bool(RAW_TABLE.search(answer)),
        "endsAbruptly": bool(answer.strip())
        and (
            answer.rstrip()[-1] in "|,:;({-"
            or answer.rstrip().count("```") % 2 != 0
            or bool(re.search(r"^\s*#{1,6}\s+\S+\s*$", answer.rstrip().splitlines()[-1]))
        ),
        "citations": citations,
        "hasCitations": bool(citations),
        "citationIdsValid": bool(citations) and all(1 <= item <= len(chunks) for item in citations),
    }


def parse_json_object(value: str) -> dict[str, Any]:
    cleaned = clean_model_text(value)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("The judge did not return a JSON object")
    # Local models occasionally emit literal newlines or tabs inside JSON strings.
    # strict=False accepts those characters without repairing structural JSON errors.
    return json.loads(cleaned[start : end + 1], strict=False)


def finding_is_traceable(value: Any, response: str, evidence: str) -> bool:
    text = str(value or "")
    quotes = [re.sub(r"\s+", " ", item).strip().lower() for item in re.findall(r'["“]([^"”]{3,})["”]', text)]
    normalized_response = re.sub(r"\s+", " ", response).lower()
    normalized_evidence = re.sub(r"\s+", " ", evidence).lower()
    response_quotes = [item for item in quotes if item in normalized_response]
    if not response_quotes:
        return False
    if (
        any(item in normalized_evidence for item in response_quotes)
        and "metadata" not in text.lower()
    ):
        return False
    evidence_match = any(
        item in normalized_evidence and item not in response_quotes for item in quotes
    )
    return evidence_match or "not present in evidence" in text.lower()


def finding_quotes_response(value: Any, response: str) -> bool:
    normalized_response = re.sub(r"\s+", " ", response).lower()
    return any(
        re.sub(r"\s+", " ", item).strip().lower() in normalized_response
        for item in re.findall(r'["“]([^"”]{3,})["”]', str(value or ""))
    )


def valid_audit_sections(
    audit: dict[str, Any], response: str = "", evidence: str = ""
) -> bool:
    expected = {
        "answer_accuracy": {"Pass", "Fail"},
        "bias_hallucination": {"Clear", "Flagged"},
        "structure_flow": {"Good", "Needs Improvement"},
        "anomalies": {"None", "Detected"},
        "formatting": {"Good", "Needs Improvement"},
        "citation_correctness": {"Valid", "Invalid", "Missing"},
    }
    if not all(
        isinstance(audit.get(field), dict)
        and audit[field].get("status") in statuses
        for field, statuses in expected.items()
    ):
        return False
    if not isinstance(audit.get("root_causes"), list):
        return False
    return True


def sanitize_audit_findings(
    audit: dict[str, Any], response: str, evidence: str
) -> dict[str, Any]:
    if audit["answer_accuracy"]["status"] == "Fail" and not finding_is_traceable(
        audit["answer_accuracy"].get("analysis"), response, evidence
    ):
        audit["answer_accuracy"] = {
            "status": "Pass",
            "analysis": "No accuracy failure could be traced to both the response and evidence.",
        }
    if audit["bias_hallucination"]["status"] == "Flagged":
        items = [
            item
            for item in audit["bias_hallucination"].get("items") or []
            if finding_is_traceable(item, response, evidence)
        ]
        audit["bias_hallucination"] = {
            "status": "Flagged" if items else "Clear",
            "items": items,
        }
    if audit["anomalies"]["status"] == "Detected":
        issues = [
            item
            for item in audit["anomalies"].get("issues") or []
            if finding_is_traceable(item, response, evidence)
        ]
        audit["anomalies"] = {"status": "Detected" if issues else "None", "issues": issues}
    if audit["citation_correctness"]["status"] == "Invalid" and not finding_is_traceable(
        audit["citation_correctness"].get("analysis"), response, evidence
    ):
        audit["citation_correctness"] = {
            "status": "Valid",
            "analysis": "No citation failure could be traced to both the response and evidence.",
        }
    formatting_text = str(audit["formatting"].get("evaluation") or "")
    if audit["formatting"]["status"] == "Needs Improvement" and (
        not finding_quotes_response(formatting_text, response)
        or re.search(r"\b(?:acceptable|used correctly|no formatting issue)\b", formatting_text, re.I)
    ):
        audit["formatting"] = {
            "status": "Good",
            "evaluation": "No formatting issue could be traced to the response.",
        }
    return audit


def valid_optimized_response(value: str, source_count: int) -> bool:
    optimized = value.strip()
    citations = [int(item) for item in CITATION.findall(optimized)]
    return bool(
        optimized
        and citations
        and all(1 <= item <= source_count for item in citations)
        and not HTML.search(optimized)
        and not RAW_TABLE.search(optimized)
    )


def audit_passes(audit: dict[str, Any]) -> bool:
    return (
        audit.get("answer_accuracy", {}).get("status") == "Pass"
        and audit.get("bias_hallucination", {}).get("status") == "Clear"
        and audit.get("structure_flow", {}).get("status") == "Good"
        and audit.get("anomalies", {}).get("status") == "None"
        and audit.get("formatting", {}).get("status") == "Good"
        and audit.get("citation_correctness", {}).get("status") == "Valid"
    )


def valid_audit(audit: dict[str, Any], source_count: int) -> bool:
    if not valid_audit_sections(audit):
        return False
    optimized = str(audit.get("optimized_response") or "").strip()
    return valid_optimized_response(optimized, source_count)


def audit_needs_refresh(case: dict[str, Any]) -> bool:
    return not valid_audit(dict(case.get("audit") or {}), len(case.get("sources") or []))


def deterministic_audit(variant: dict[str, Any], error: Exception) -> dict[str, Any]:
    issues = list(variant.get("qualityIssues") or grounding_issues(variant["answer"], variant["chunks"]))
    citation_issues = {
        "missing citations",
        "invalid citation number",
        "citation lacks passage support",
        "uncited factual paragraph",
    }
    anomalous = [
        issue
        for issue in issues
        if issue in {"raw HTML", "raw Markdown table", "incomplete ending", "repeated content", "empty answer"}
    ]
    unsupported = "unsupported acronym expansion" in issues
    citations_status = (
        "Missing"
        if "missing citations" in issues
        else "Invalid"
        if citation_issues.intersection(issues)
        else "Valid"
    )
    return {
        "answer_accuracy": {
            "status": "Fail" if issues else "Pass",
            "analysis": (
                "Deterministic checks found: " + ", ".join(issues) + "."
                if issues
                else "All factual blocks passed local citation and passage-support checks."
            ),
        },
        "bias_hallucination": {
            "status": "Flagged" if unsupported else "Clear",
            "items": ["Unsupported acronym expansion detected."] if unsupported else [],
        },
        "structure_flow": {
            "status": "Needs Improvement" if anomalous else "Good",
            "critique": ", ".join(anomalous) if anomalous else "No deterministic structure issue detected.",
        },
        "anomalies": {"status": "Detected" if anomalous else "None", "issues": anomalous},
        "formatting": {
            "status": "Needs Improvement" if anomalous else "Good",
            "evaluation": ", ".join(anomalous) if anomalous else "Markdown checks passed.",
        },
        "citation_correctness": {
            "status": citations_status,
            "analysis": (
                "Deterministic citation checks found: "
                + ", ".join(sorted(citation_issues.intersection(issues)))
                if citations_status != "Valid"
                else "Citation identifiers and passage support passed deterministic checks."
            ),
        },
        "root_causes": [f"Structured judge fallback used after: {type(error).__name__}"],
    }


def audit_pair(
    url: str,
    judge_model: str,
    base: dict[str, Any],
    variants: list[dict[str, Any]],
) -> tuple[dict[str, Any], float]:
    schema = {
        "answer_accuracy": {"status": "Pass or Fail", "analysis": "short analysis; failures must quote response and evidence"},
        "bias_hallucination": {"status": "Clear or Flagged", "items": ["Response: exact quote; Evidence: exact quote or not present in evidence"]},
        "structure_flow": {"status": "Good or Needs Improvement", "critique": "short critique"},
        "anomalies": {"status": "None or Detected", "issues": ["Response: exact quote; Evidence: exact quote or not present in evidence"]},
        "formatting": {"status": "Good or Needs Improvement", "evaluation": "short evaluation"},
        "citation_correctness": {"status": "Valid or Invalid or Missing", "analysis": "accuracy check; invalid findings must quote response and evidence"},
        "root_causes": ["concise cause"],
    }
    audit_format = {
        "type": "object",
        "properties": {
            "answer_accuracy": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["Pass", "Fail"]},
                    "analysis": {"type": "string"},
                },
                "required": ["status", "analysis"],
            },
            "bias_hallucination": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["Clear", "Flagged"]},
                    "items": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                },
                "required": ["status", "items"],
            },
            "structure_flow": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["Good", "Needs Improvement"]},
                    "critique": {"type": "string"},
                },
                "required": ["status", "critique"],
            },
            "anomalies": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["None", "Detected"]},
                    "issues": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                },
                "required": ["status", "issues"],
            },
            "formatting": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["Good", "Needs Improvement"]},
                    "evaluation": {"type": "string"},
                },
                "required": ["status", "evaluation"],
            },
            "citation_correctness": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["Valid", "Invalid", "Missing"]},
                    "analysis": {"type": "string"},
                },
                "required": ["status", "analysis"],
            },
            "root_causes": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 3,
            },
        },
        "required": [
            "answer_accuracy",
            "bias_hallucination",
            "structure_flow",
            "anomalies",
            "formatting",
            "citation_correctness",
            "root_causes",
        ],
    }
    system = (
        "You are a strict RAG quality-control judge. Evaluate only the current RESPONSE against "
        "AVAILABLE EVIDENCE; never import a claim from another response or from evidence into the "
        "response. A claim is unsupported only when the exact claim is absent from the cited evidence. "
        "If an exact number or specification appears in evidence, treat it as supported even when it "
        "looks unusual. Treat speaker names and dates as slide metadata unless the response presents "
        "them as a substantive insight. "
        "For every Fail, Flagged, Detected, or Invalid finding, include an exact quote from the RESPONSE "
        "and an exact quote from AVAILABLE EVIDENCE. If no supporting evidence exists, write the exact "
        "response quote followed by the phrase 'not present in evidence'. Do not flag a finding that "
        "you cannot trace this way. Evaluate the response only against AVAILABLE "
        "EVIDENCE. A claim is unsupported unless the evidence explicitly supports it. Check whether "
        "every [n] maps to evidence [n] and supports the nearby claim. Flag invented prices, dates, "
        "specifications, causal claims, recommendations, owners, deadlines, or extrapolations. Also "
        "flag raw HTML, malformed Markdown, raw pipe-table text, repetition, robotic phrasing, and "
        "abrupt endings. Keep every audit analysis under 40 words and use no more than three items in "
        "any list. Return valid JSON only, with no code fence."
    )
    audits: dict[str, Any] = {}
    elapsed_ms = 0.0
    for variant in variants:
        audit_chunks = [
            {**chunk, "text": str(chunk["text"])[:2000]}
            for chunk in variant["chunks"]
        ]
        evidence = source_text(audit_chunks, base)
        user = (
            f"Knowledge base: {base['name']}\nDescription: {base.get('description', '')}\n\n"
            f"QUERY:\n{variant['prompt']}\n\nRESPONSE:\n{variant['answer']}\n\n"
            f"AVAILABLE EVIDENCE:\n{evidence or '[No retrieved evidence]'}\n\n"
            f"Return this schema:\n{json.dumps(schema)}"
        )
        last_error: Exception | None = None
        for _attempt in range(3):
            judge = ollama_chat(
                url,
                judge_model,
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                context=8192,
                temperature=0.0,
                top_p=0.9,
                max_tokens=1024,
                json_mode=audit_format,
            )
            elapsed_ms += judge.elapsed_ms
            try:
                audit = parse_json_object(judge.content)
                if not valid_audit_sections(audit):
                    raise ValueError("The judge returned an incomplete audit")
                audit = sanitize_audit_findings(audit, variant["answer"], evidence)
                break
            except Exception as error:
                last_error = error
        else:
            audit = deterministic_audit(
                variant,
                last_error or ValueError("The judge did not return a valid audit"),
            )
        if audit_passes(audit) and valid_optimized_response(
            str(variant["answer"]), len(variant["chunks"])
        ):
            audit["optimized_response"] = str(variant["answer"]).strip()
            audits[variant["variant"]] = audit
            continue
        optimized_system = (
            "Write the best corrected answer to the query using only AVAILABLE EVIDENCE. Return only "
            "the answer as Markdown, with no preface or code fence. Keep it under 140 words and include "
            "no more than six factual claims. Every factual claim must have a directly supporting [n] "
            "citation. Use at least one citation. Do not infer relationships between list items, expand "
            "acronyms, calculate missing values, or add recommendations unless the evidence explicitly "
            "supports them. Use short headings or bullets, never a table, HTML, or raw pipe characters. "
            "If the evidence is insufficient, say what cannot be determined and cite the passage that "
            "shows the available context."
        )
        optimized_error: Exception | None = None
        for _attempt in range(3):
            optimized_result = ollama_chat(
                url,
                judge_model,
                [
                    {"role": "system", "content": optimized_system},
                    {
                        "role": "user",
                        "content": (
                            f"QUERY:\n{variant['prompt']}\n\nAVAILABLE EVIDENCE:\n"
                            f"{evidence or '[No retrieved evidence]'}"
                        ),
                    },
                ],
                context=8192,
                temperature=0.0,
                top_p=0.9,
                max_tokens=512,
            )
            elapsed_ms += optimized_result.elapsed_ms
            optimized = clean_model_text(optimized_result.content)
            if valid_optimized_response(optimized, len(variant["chunks"])):
                audit["optimized_response"] = optimized
                audits[variant["variant"]] = audit
                break
            optimized_error = ValueError("The corrected answer failed citation or formatting validation")
        else:
            raise optimized_error or ValueError("The judge did not return a valid corrected answer")
    return audits, elapsed_ms


def safe_text(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text or fallback


def safe_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [safe_text(value, "") for value in values if safe_text(value, "")]


def markdown_audit(case: dict[str, Any]) -> str:
    audit = case["audit"]
    checks = case["checks"]
    anomalies = safe_list(audit.get("anomalies", {}).get("issues"))
    if checks["containsHtml"]:
        anomalies.append("Raw HTML appears in the response.")
    if checks["containsRawTable"]:
        anomalies.append("The response contains raw pipe-table formatting.")
    if checks["endsAbruptly"] or case["doneReason"] == "length":
        anomalies.append("The response appears to end before the thought is complete.")
    citation = dict(audit.get("citation_correctness") or {})
    if not checks["hasCitations"]:
        citation = {"status": "Missing", "analysis": "No source citations were included."}
    elif not checks["citationIdsValid"]:
        citation = {"status": "Invalid", "analysis": "At least one citation identifier does not map to a retrieved source."}
    roots = safe_list(audit.get("root_causes"))
    if case.get("templateIssue"):
        roots.insert(0, case["templateIssue"])
    lines = [
        "## 1. QUALITY CONTROL AUDIT Report",
        f"- **Answer Accuracy:** {safe_text(audit.get('answer_accuracy', {}).get('status'), 'Fail')} - {safe_text(audit.get('answer_accuracy', {}).get('analysis'), 'The response could not be verified against the retrieved evidence.')}",
        f"- **Bias & Hallucination:** {safe_text(audit.get('bias_hallucination', {}).get('status'), 'Flagged')} - {('; '.join(safe_list(audit.get('bias_hallucination', {}).get('items')))) or 'No unsupported claims identified.'}",
        f"- **Structure & Flow:** {safe_text(audit.get('structure_flow', {}).get('status'), 'Needs Improvement')} - {safe_text(audit.get('structure_flow', {}).get('critique'), 'The response needs clearer organization.')}",
        f"- **Anomalies:** {('Detected' if anomalies else 'None')} - {('; '.join(dict.fromkeys(anomalies))) if anomalies else 'No structural anomalies detected.'}",
        f"- **Formatting:** {safe_text(audit.get('formatting', {}).get('status'), 'Needs Improvement')} - {safe_text(audit.get('formatting', {}).get('evaluation'), 'Formatting needs refinement.')}",
        f"- **Citation Correctness:** {safe_text(citation.get('status'), 'Missing')} - {safe_text(citation.get('analysis'), 'Citation support could not be verified.')}",
        "",
        "## 2. ROOT CAUSE ANALYSIS & GAP IDENTIFICATION",
    ]
    lines.extend(f"- {root}" for root in roots or ["No material failure was identified."])
    lines.extend(
        [
            "",
            "## 3. OPTIMIZED CHAT RESPONSE",
            safe_text(audit.get("optimized_response"), "The retrieved passages do not contain enough evidence to answer this request reliably."),
        ]
    )
    return "\n".join(lines)


def template_issue(template_id: str) -> str:
    return ""


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:0.6b")
    parser.add_argument("--answer-model", default="qwen3.5:4b-q4_K_M")
    parser.add_argument("--enhancement-model", default="qwen3.5:2b-q4_K_M")
    parser.add_argument("--judge-model", default="qwen3.5:9b-q4_K_M")
    parser.add_argument("--limit", type=int, default=0, help="Limit logical prompts for a smoke test")
    parser.add_argument(
        "--refresh-incomplete-audits",
        action="store_true",
        help="Re-run only incomplete, malformed, or cross-contaminated QC entries",
    )
    parser.add_argument(
        "--refresh-failures",
        action="store_true",
        help="Re-run only prompt pairs with deterministic or six-vector QC failures",
    )
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    bases = list(config.get("knowledgeBases") or [])
    engine = RagEngine(str(args.data_dir), args.ollama_url, args.embedding_model)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.output_dir / "results.json"
    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8")) if checkpoint_path.exists() else {"cases": []}
    if args.refresh_failures:
        passing = {
            "answer_accuracy": "Pass",
            "bias_hallucination": "Clear",
            "structure_flow": "Good",
            "anomalies": "None",
            "formatting": "Good",
            "citation_correctness": "Valid",
        }
        failed_pairs = {
            (case["knowledgeBaseId"], case["sourceId"])
            for case in checkpoint["cases"]
            if case.get("qualityIssues")
            or any(
                case.get("audit", {}).get(section, {}).get("status") != expected
                for section, expected in passing.items()
            )
        }
        checkpoint["cases"] = [
            case
            for case in checkpoint["cases"]
            if (case["knowledgeBaseId"], case["sourceId"]) not in failed_pairs
        ]
        save_json(checkpoint_path, checkpoint)
        print(f"Refreshing {len(failed_pairs)} failed prompt pairs.", flush=True)
    finished = {case["id"] for case in checkpoint["cases"]}

    logical: list[tuple[dict[str, Any], str, str, str]] = []
    if args.refresh_incomplete_audits:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for case in checkpoint["cases"]:
            grouped.setdefault((case["knowledgeBaseId"], case["sourceId"]), []).append(case)
        duplicated = {
            case["id"]
            for pair in grouped.values()
            if len(pair) == 2
            and pair[0].get("audit", {}).get("optimized_response")
            and pair[0].get("audit", {}).get("optimized_response")
            == pair[1].get("audit", {}).get("optimized_response")
            for case in pair
        }
        refresh = [
            case
            for case in checkpoint["cases"]
            if audit_needs_refresh(case) or case["id"] in duplicated
        ]
        bases_by_id = {str(base["id"]): base for base in bases}
        for position, case in enumerate(refresh, 1):
            print(
                f"[{position}/{len(refresh)}] refreshing {case['knowledgeBase']} / "
                f"{case['label']} / {case['variant']}",
                flush=True,
            )
            variant = {
                "variant": case["variant"],
                "prompt": case["prompt"],
                "answer": case["answer"],
                "chunks": [
                    {
                        "file": source["file"],
                        "location": source["location"],
                        "heading": source.get("heading", ""),
                        "text": source["text"],
                    }
                    for source in case["sources"]
                ],
            }
            audited, judge_ms = audit_pair(
                args.ollama_url,
                args.judge_model,
                bases_by_id[case["knowledgeBaseId"]],
                [variant],
            )
            unload_model(args.ollama_url, args.judge_model)
            case["audit"] = audited[case["variant"]]
            case["judgeMs"] = round(judge_ms, 2)
            save_json(checkpoint_path, checkpoint)
    else:
        for base in bases:
            for index, suggestion in enumerate(base.get("suggestedPrompts") or [], 1):
                logical.append((base, f"suggested-{index}", str(suggestion.get("label") or f"Suggested {index}"), str(suggestion["prompt"])))
            for template_id, name, prompt in TEMPLATES:
                logical.append((base, f"template-{template_id}", name, prompt))
        if args.limit > 0:
            logical = logical[: args.limit]

    total = len(logical)
    for position, (base, source_id, label, original_prompt) in enumerate(logical, 1):
        baseline_id = f"{base['id']}:{source_id}:baseline"
        improved_id = f"{base['id']}:{source_id}:improved"
        if baseline_id in finished and improved_id in finished:
            print(f"[{position}/{total}] cached {base['name']} / {label}", flush=True)
            continue
        print(f"[{position}/{total}] testing {base['name']} / {label}", flush=True)
        improved_prompt, improvement_ms, improvement_valid = improve_prompt(
            args.ollama_url, args.enhancement_model, original_prompt, base
        )
        unload_model(args.ollama_url, args.enhancement_model)
        variants: list[dict[str, Any]] = []
        for variant, prompt in (("baseline", original_prompt), ("improved", improved_prompt)):
            result = run_answer(engine, args.ollama_url, args.answer_model, base, prompt, config)
            variants.append(
                {
                    "variant": variant,
                    "prompt": prompt,
                    **result,
                    "checks": deterministic_checks(result["answer"], result["chunks"]),
                }
            )
        unload_model(args.ollama_url, args.answer_model)
        try:
            judged, judge_ms = audit_pair(args.ollama_url, args.judge_model, base, variants)
        except Exception as error:
            print(f"  judge retry after: {error}", flush=True)
            judged, judge_ms = audit_pair(args.ollama_url, args.judge_model, base, variants)
        finally:
            unload_model(args.ollama_url, args.judge_model)
        for variant in variants:
            case_id = baseline_id if variant["variant"] == "baseline" else improved_id
            if case_id in finished:
                continue
            case = {
                "id": case_id,
                "knowledgeBase": base["name"],
                "knowledgeBaseId": base["id"],
                "category": "suggested prompt" if source_id.startswith("suggested-") else "prompt template",
                "sourceId": source_id,
                "label": label,
                "variant": variant["variant"],
                "originalPrompt": original_prompt,
                "prompt": variant["prompt"],
                "improvementModel": args.enhancement_model,
                "improvementMs": improvement_ms if variant["variant"] == "improved" else 0.0,
                "improvementPassedValidation": improvement_valid if variant["variant"] == "improved" else None,
                "answerModel": args.answer_model,
                "answer": variant["answer"],
                "sources": [
                    {"id": index, "file": chunk["file"], "location": chunk["location"], "heading": chunk.get("heading", ""), "text": chunk["text"]}
                    for index, chunk in enumerate(variant["chunks"], 1)
                ],
                "retrievalMs": round(variant["retrievalMs"], 2),
                "answerMs": round(variant["answerMs"], 2),
                "repairMs": round(variant["repairMs"], 2),
                "qualityIssues": variant["qualityIssues"],
                "judgeMs": round(judge_ms, 2),
                "doneReason": variant["doneReason"],
                "checks": variant["checks"],
                "templateIssue": template_issue(source_id.removeprefix("template-")),
                "audit": judged.get(variant["variant"], {}),
            }
            checkpoint["cases"].append(case)
            finished.add(case_id)
        checkpoint.update(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "answerModel": args.answer_model,
                "judgeModel": args.judge_model,
                "knowledgeBases": len(bases),
            }
        )
        save_json(checkpoint_path, checkpoint)

    cases = checkpoint["cases"]
    for case in cases:
        audit = case.get("audit") or {}
        if audit.get("optimized_response"):
            audit["optimized_response"] = re.sub(
                r"\[\[(\d+)\]\]", r"[\1]", str(audit["optimized_response"])
            )
    save_json(checkpoint_path, checkpoint)
    report_order = {
        ("suggested prompt", "baseline"): 0,
        ("prompt template", "baseline"): 1,
        ("suggested prompt", "improved"): 2,
        ("prompt template", "improved"): 3,
    }
    base_order = {str(base["id"]): index for index, base in enumerate(bases)}
    cases = sorted(
        cases,
        key=lambda case: (
            report_order[(case["category"], case["variant"])],
            base_order.get(case["knowledgeBaseId"], 999),
            case["sourceId"],
        ),
    )
    report = [
        "# RavenDock RAG Prompt Quality-Control Matrix",
        "",
        f"- Knowledge bases: {len(bases)}",
        f"- Tested responses: {len(cases)}",
        f"- Document answer model: `{args.answer_model}`",
        f"- Improve Prompt model: `{args.enhancement_model}`",
        f"- Independent QC and rewrite model: `{args.judge_model}`",
        "- Scope: exact in-app suggested prompts and default templates, before and after Improve Prompt",
        "",
    ]
    for number, case in enumerate(cases, 1):
        report.extend(
            [
                f"# Test {number}: {case['knowledgeBase']} / {case['label']} / {case['variant'].title()}",
                "",
                f"**Submitted prompt:** {case['prompt']}",
                "",
                markdown_audit(case),
                "",
                "---",
                "",
            ]
        )
    report_text = re.sub(r"\[\[(\d+)\]\]", r"[\1]", "\n".join(report))
    (args.output_dir / "QC_REPORT.md").write_text(report_text, encoding="utf-8")
    print(json.dumps({"cases": len(cases), "report": str(args.output_dir / 'QC_REPORT.md')}), flush=True)


if __name__ == "__main__":
    main()
