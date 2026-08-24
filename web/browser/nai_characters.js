/** Compact multi-character editor for NovelAI JSON cards. */

let nextCharacterUid = 0;
export const CHARACTER_PROMPT_MIN_HEIGHT = 52;

function finiteCoordinate(value) {
  if (value === "" || value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function cleanPrompt(value) {
  return typeof value === "string" ? value : "";
}

export function naiCharacterPromptHeight(scrollHeight, minHeight = CHARACTER_PROMPT_MIN_HEIGHT) {
  const floor = Number.isFinite(Number(minHeight)) ? Number(minHeight) : CHARACTER_PROMPT_MIN_HEIGHT;
  const measured = Number(scrollHeight);
  if (!Number.isFinite(measured)) return floor;
  return Math.max(floor, Math.ceil(measured));
}

function supportsFieldSizing() {
  return typeof CSS !== "undefined" && Boolean(CSS.supports?.("field-sizing", "content"));
}

export function autosizePromptTextarea(textarea, minHeight = CHARACTER_PROMPT_MIN_HEIGHT) {
  if (!textarea) return naiCharacterPromptHeight(Number.NaN, minHeight);
  if (supportsFieldSizing()) {
    textarea.style.height = "";
    return naiCharacterPromptHeight(textarea.scrollHeight, minHeight);
  }
  if (!textarea.isConnected || textarea.offsetWidth <= 0) {
    return naiCharacterPromptHeight(Number.NaN, minHeight);
  }
  const previousMinHeight = textarea.style.minHeight;
  textarea.style.minHeight = "0px";
  textarea.style.height = "0px";
  const next = naiCharacterPromptHeight(textarea.scrollHeight, minHeight);
  textarea.style.minHeight = previousMinHeight;
  textarea.style.height = `${next}px`;
  return next;
}

function resizeCharacterPrompt(textarea) {
  autosizePromptTextarea(textarea);
}

export function normalizeNaiCharacters(value) {
  const source = Array.isArray(value) ? value : [];
  const characters = source
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const character = {
        positive: cleanPrompt(entry.positive ?? entry.prompt),
        negative: cleanPrompt(entry.negative ?? entry.negative_prompt),
      };
      const x = finiteCoordinate(entry.x);
      const y = finiteCoordinate(entry.y);
      const automatic = entry.use_position === false || entry.automatic === true;
      if (!automatic && x !== null && y !== null) {
        character.x = x;
        character.y = y;
      }
      return character;
    });
  return characters;
}

export function naiCharactersUsePositions(value) {
  const characters = normalizeNaiCharacters(value);
  return Boolean(
    characters.length
    && characters.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y)),
  );
}

export function evenlyDistributedCharacterPositions(count, aspect = 1) {
  const total = Math.max(0, Number.parseInt(count, 10) || 0);
  if (!total) return [];
  const safeAspect = Math.max(0.25, Math.min(4, Number(aspect) || 1));
  const columns = Math.max(1, Math.min(total, Math.ceil(Math.sqrt(total * safeAspect))));
  const rows = Math.ceil(total / columns);
  return Array.from({ length: total }, (_, index) => ({
    x: Number((((index % columns) + 0.5) / columns).toFixed(3)),
    y: Number(((Math.floor(index / columns) + 0.5) / rows).toFixed(3)),
  }));
}

function iconButton(documentLike, text, label) {
  const button = documentLike.createElement("button");
  button.type = "button";
  button.className = "nai-card-icon-button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

export function createNaiCharactersEditor(
  root,
  {
    onChange = () => {},
    translate = (value) => value,
    aspect = 1,
  } = {},
) {
  if (!root?.ownerDocument) return null;
  const documentLike = root.ownerDocument;
  let records = [];
  let currentAspect = Math.max(0.25, Math.min(4, Number(aspect) || 1));
  let positionDraft = [];

  const list = documentLike.createElement("div");
  list.className = "nai-card-characters-list";

  const popover = documentLike.createElement("div");
  popover.className = "nai-card-position-popover";
  popover.hidden = true;
  const popoverHeader = documentLike.createElement("div");
  popoverHeader.className = "nai-card-position-header";
  const popoverTitle = documentLike.createElement("strong");
  popoverTitle.textContent = translate("角色位置");
  const positionReadout = documentLike.createElement("span");
  positionReadout.className = "nai-card-position-readout";
  popoverHeader.append(popoverTitle, positionReadout);
  const canvas = documentLike.createElement("div");
  canvas.className = "nai-card-position-canvas";
  const popoverActions = documentLike.createElement("div");
  popoverActions.className = "nai-card-position-actions";
  const cancelPositions = documentLike.createElement("button");
  cancelPositions.type = "button";
  cancelPositions.className = "modal-secondary-button";
  cancelPositions.textContent = translate("取消");
  const clearPositions = documentLike.createElement("button");
  clearPositions.type = "button";
  clearPositions.className = "modal-secondary-button";
  clearPositions.textContent = translate("清除位置");
  const savePositions = documentLike.createElement("button");
  savePositions.type = "button";
  savePositions.className = "modal-primary-button";
  savePositions.textContent = translate("保存位置");
  popoverActions.append(cancelPositions, clearPositions, savePositions);
  popover.append(popoverHeader, canvas, popoverActions);

  root.replaceChildren(list, popover);

  function notify() {
    onChange(api.getValue());
  }

  function renderPositionCanvas() {
    canvas.replaceChildren();
    const width = Math.max(140, Math.min(280, Math.round(210 * currentAspect)));
    const height = Math.max(140, Math.min(280, Math.round(210 / currentAspect)));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    positionDraft.forEach((position, index) => {
      const dot = documentLike.createElement("button");
      dot.type = "button";
      dot.className = "nai-card-position-dot";
      dot.textContent = String(index + 1);
      dot.style.left = `${position.x * 100}%`;
      dot.style.top = `${position.y * 100}%`;
      const update = (event) => {
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        position.x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        position.y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
        dot.style.left = `${position.x * 100}%`;
        dot.style.top = `${position.y * 100}%`;
        positionReadout.textContent = `${translate("角色")} ${index + 1} · X ${position.x.toFixed(3)} · Y ${position.y.toFixed(3)}`;
      };
      dot.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        dot.setPointerCapture?.(event.pointerId);
        update(event);
      });
      dot.addEventListener("pointermove", (event) => {
        if (dot.hasPointerCapture?.(event.pointerId)) update(event);
      });
      dot.addEventListener("pointerup", (event) => {
        dot.releasePointerCapture?.(event.pointerId);
      });
      dot.addEventListener("focus", () => {
        positionReadout.textContent = `${translate("角色")} ${index + 1} · X ${position.x.toFixed(3)} · Y ${position.y.toFixed(3)}`;
      });
      canvas.appendChild(dot);
    });
  }

  function openPositions() {
    if (!records.length) return;
    const fallback = evenlyDistributedCharacterPositions(records.length, currentAspect);
    positionDraft = records.map((record, index) => ({
      x: Number.isFinite(record.x) ? record.x : fallback[index].x,
      y: Number.isFinite(record.y) ? record.y : fallback[index].y,
    }));
    positionReadout.textContent = "";
    popover.hidden = false;
    renderPositionCanvas();
  }

  function closePositions() {
    popover.hidden = true;
    positionDraft = [];
  }

  function coordinateLabel(record) {
    return Number.isFinite(record.x) && Number.isFinite(record.y)
      ? `X ${record.x.toFixed(3)} · Y ${record.y.toFixed(3)}`
      : "";
  }

  function refreshCard(card, record, index) {
    if (!card) return;
    card.className = `nai-card-character nai-card-character-${record.tab}`;
    const title = card.querySelector("strong");
    if (title) title.textContent = `${translate("角色")} ${index + 1}`;
    card.querySelectorAll(".nai-card-polarity-switch .view-button").forEach((button) => {
      const active = button.dataset.tab === record.tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const coordinates = card.querySelector(".nai-card-coordinate");
    if (coordinates) coordinates.textContent = coordinateLabel(record);
    const up = card.querySelector('[data-character-action="up"]');
    const down = card.querySelector('[data-character-action="down"]');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === records.length - 1;
    const textarea = card.querySelector("textarea");
    if (!textarea) return;
    textarea.placeholder = record.tab === "negative"
      ? translate("角色负面提示词")
      : translate("角色正面提示词");
    if (textarea.value !== record[record.tab]) textarea.value = record[record.tab];
    resizeCharacterPrompt(textarea);
  }

  function refreshCards() {
    Array.from(list.children).forEach((card, index) => {
      refreshCard(card, records[index], index);
    });
  }

  function render() {
    list.replaceChildren();
    records.forEach((record, index) => {
      const card = documentLike.createElement("section");
      const header = documentLike.createElement("div");
      header.className = "nai-card-character-header";
      const title = documentLike.createElement("strong");
      const polarity = documentLike.createElement("div");
      polarity.className = "view-switch nai-card-polarity-switch";
      polarity.setAttribute("role", "group");
      polarity.setAttribute("aria-label", translate("角色提示词"));
      ["positive", "negative"].forEach((tab) => {
        const button = documentLike.createElement("button");
        button.type = "button";
        button.className = "view-button";
        button.dataset.tab = tab;
        button.textContent = translate(tab === "negative" ? "负面" : "正面");
        button.addEventListener("click", () => {
          if (record.tab === tab) return;
          record.tab = tab;
          refreshCard(card, record, index);
        });
        polarity.appendChild(button);
      });
      const coordinates = documentLike.createElement("span");
      coordinates.className = "nai-card-coordinate";
      const actions = documentLike.createElement("div");
      actions.className = "nai-card-character-actions";
      const up = iconButton(documentLike, "↑", translate("上移"));
      const down = iconButton(documentLike, "↓", translate("下移"));
      const remove = iconButton(documentLike, "×", translate("删除角色"));
      up.dataset.characterAction = "up";
      down.dataset.characterAction = "down";
      up.onclick = () => {
        [records[index - 1], records[index]] = [records[index], records[index - 1]];
        render();
        notify();
      };
      down.onclick = () => {
        [records[index], records[index + 1]] = [records[index + 1], records[index]];
        render();
        notify();
      };
      remove.onclick = () => {
        records.splice(index, 1);
        render();
        notify();
      };
      actions.append(up, down, remove);
      header.append(title, polarity, coordinates, actions);

      const textarea = documentLike.createElement("textarea");
      textarea.className = "nai-card-character-prompt";
      textarea.rows = 1;
      textarea.spellcheck = false;
      textarea.addEventListener("input", () => {
        record[record.tab] = textarea.value;
        resizeCharacterPrompt(textarea);
        notify();
      });

      card.append(header, textarea);
      list.appendChild(card);
      refreshCard(card, record, index);
    });
  }

  function addCharacter() {
    records.push({
      uid: ++nextCharacterUid,
      positive: "",
      negative: "",
      tab: "positive",
    });
    render();
    notify();
    list.lastElementChild?.querySelector("textarea")?.focus();
  }

  cancelPositions.onclick = closePositions;
  clearPositions.onclick = () => {
    for (const record of records) {
      delete record.x;
      delete record.y;
    }
    closePositions();
    refreshCards();
    notify();
  };
  savePositions.onclick = () => {
    records.forEach((record, index) => {
      record.x = finiteCoordinate(positionDraft[index]?.x) ?? 0.5;
      record.y = finiteCoordinate(positionDraft[index]?.y) ?? 0.5;
    });
    closePositions();
    refreshCards();
    notify();
  };

  const api = {
    getValue() {
      return records.map((record) => {
        const value = {
          positive: record.positive,
          negative: record.negative,
        };
        if (Number.isFinite(record.x) && Number.isFinite(record.y)) {
          value.x = record.x;
          value.y = record.y;
        }
        return value;
      });
    },
    setValue(value) {
      records = normalizeNaiCharacters(value).map((character) => ({
        uid: ++nextCharacterUid,
        ...character,
        tab: "positive",
      }));
      closePositions();
      render();
    },
    addCharacter,
    openPositions,
    resizeAll() {
      list.querySelectorAll("textarea").forEach((textarea) => {
        resizeCharacterPrompt(textarea);
      });
    },
    setAspect(value) {
      currentAspect = Math.max(0.25, Math.min(4, Number(value) || 1));
      if (!popover.hidden) renderPositionCanvas();
    },
    focusFirst() {
      list.querySelector("textarea")?.focus();
    },
  };

  render();
  return api;
}
