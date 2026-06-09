const state = {
  elementRefs: new Map(),
  elementIdCounter: 0
};

function log(...args) {
  console.log('[Content]', ...args);
}

function generateElementId() {
  return `elem-${++state.elementIdCounter}`;
}

function getAccessibleName(element) {
  if (element.getAttribute('aria-label')) {
    return element.getAttribute('aria-label');
  }

  const labelledById = element.getAttribute('aria-labelledby');
  if (labelledById) {
    const labelElement = document.getElementById(labelledById);
    if (labelElement) {
      return labelElement.textContent?.trim();
    }
  }

  if (element.getAttribute('placeholder')) {
    return element.getAttribute('placeholder');
  }

  const label = element.closest('label');
  if (label) {
    return label.textContent?.trim();
  }

  const forId = element.getAttribute('id');
  if (forId) {
    const forLabel = document.querySelector(`label[for="${forId}"]`);
    if (forLabel) {
      return forLabel.textContent?.trim();
    }
  }

  if (element.type === 'submit' || element.type === 'button') {
    return element.value;
  }

  if (element.tagName === 'BUTTON') {
    return element.textContent?.trim();
  }

  if (element.getAttribute('title')) {
    return element.getAttribute('title');
  }

  if (element.alt) {
    return element.alt;
  }

  return '';
}

function getRole(element) {
  if (element.getAttribute('role')) {
    return element.getAttribute('role');
  }

  const tagName = element.tagName.toLowerCase();

  const roleMap = {
    'button': 'button',
    'a': 'link',
    'input': getInputRole(element),
    'textarea': 'textbox',
    'select': 'combobox',
    'form': 'form',
    'table': 'table',
    'ul': 'list',
    'ol': 'list',
    'li': 'listitem',
    'h1': 'heading',
    'h2': 'heading',
    'h3': 'heading',
    'h4': 'heading',
    'h5': 'heading',
    'h6': 'heading',
    'nav': 'navigation',
    'header': 'banner',
    'footer': 'contentinfo',
    'main': 'main',
    'aside': 'complementary',
    'article': 'article',
    'section': 'region',
    'img': 'image',
    'svg': 'image',
    'dialog': 'dialog',
    'details': 'group',
    'summary': 'button'
  };

  return roleMap[tagName] || 'generic';
}

function getInputRole(element) {
  const type = element.type?.toLowerCase() || 'text';
  const inputRoleMap = {
    'text': 'textbox',
    'password': 'textbox',
    'email': 'textbox',
    'tel': 'textbox',
    'url': 'textbox',
    'search': 'searchbox',
    'number': 'spinbutton',
    'range': 'slider',
    'checkbox': 'checkbox',
    'radio': 'radio',
    'submit': 'button',
    'reset': 'button',
    'button': 'button',
    'date': 'combobox',
    'time': 'combobox',
    'datetime-local': 'combobox',
    'month': 'combobox',
    'week': 'combobox',
    'color': 'button',
    'file': 'button'
  };
  return inputRoleMap[type] || 'textbox';
}

function isInteractive(element) {
  const tagName = element.tagName.toLowerCase();
  const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'summary'];

  if (interactiveTags.includes(tagName)) {
    return true;
  }

  if (element.getAttribute('role') && ['button', 'link', 'menuitem', 'tab'].includes(element.getAttribute('role'))) {
    return true;
  }

  if (element.onclick || element.getAttribute('onclick')) {
    return true;
  }

  const cursor = window.getComputedStyle(element).cursor;
  if (cursor === 'pointer') {
    const hasText = element.textContent?.trim().length > 0;
    const hasChildren = element.children.length > 0;
    if (hasText || hasChildren) {
      return true;
    }
  }

  return false;
}

function isVisible(element) {
  if (element.offsetParent === null) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  if (element.offsetWidth <= 0 || element.offsetHeight <= 0) {
    return false;
  }

  return true;
}

function buildAccessibilityTree(root = document.body) {
  const nodes = [];

  function traverse(element, parentId = null) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    if (!isVisible(element)) {
      return;
    }

    const role = getRole(element);
    const name = getAccessibleName(element);
    const interactive = isInteractive(element);

    let shouldInclude = interactive || role !== 'generic';

    const rect = element.getBoundingClientRect();
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0;

    if (!shouldInclude && inViewport) {
      const text = element.textContent?.trim();
      if (text && text.length > 0 && text.length < 200) {
        shouldInclude = true;
      }
    }

    let nodeId = null;
    if (shouldInclude) {
      nodeId = generateElementId();
      state.elementRefs.set(nodeId, element);

      const node = {
        id: nodeId,
        role,
        name,
        tagName: element.tagName.toLowerCase(),
        textContent: element.textContent?.trim().substring(0, 200),
        interactive,
        visible: true,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        attributes: {},
        parentId
      };

      if (element.id) node.attributes.id = element.id;
      if (element.className) node.attributes.className = element.className;
      if (element.tagName.toLowerCase() === 'input' && element.type) {
        node.attributes.type = element.type;
      }
      if (element.tagName.toLowerCase() === 'input' || element.tagName.toLowerCase() === 'textarea') {
        node.attributes.value = element.value?.substring(0, 100);
      }
      if (element.tagName.toLowerCase() === 'a' && element.href) {
        node.attributes.href = element.href;
      }
      if (element.checked !== undefined) {
        node.attributes.checked = element.checked;
      }
      if (element.disabled) {
        node.attributes.disabled = true;
      }

      nodes.push(node);
    }

    for (const child of element.children) {
      traverse(child, nodeId || parentId);
    }
  }

  traverse(root);
  return nodes;
}

function extractPageText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!node.textContent?.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const texts = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim();
    if (text) {
      texts.push(text);
    }
  }

  return texts.join('\n');
}

function findElementByRef(ref) {
  return state.elementRefs.get(ref);
}

function getElementBySelector(selector) {
  return document.querySelector(selector);
}

function getElementByCoordinates(x, y) {
  return document.elementFromPoint(x, y);
}

function focusElement(element) {
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus();
    return true;
  }
  return false;
}

function setFormValue(element, value) {
  if (!element) return false;

  if (element.tagName.toLowerCase() === 'input' || element.tagName.toLowerCase() === 'textarea') {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (element.isContentEditable) {
    element.textContent = value;
    return true;
  }

  if (element.tagName.toLowerCase() === 'select') {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}

function getFormValue(element) {
  if (!element) return null;

  if ('value' in element) {
    return element.value;
  }

  if (element.isContentEditable) {
    return element.textContent;
  }

  return null;
}

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console)
};

const consoleMessages = [];

function interceptConsole(type, ...args) {
  const message = {
    id: `console-${Date.now()}-${Math.random()}`,
    type,
    timestamp: new Date().toISOString(),
    args: args.map(arg => {
      try {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
      } catch {
        return String(arg);
      }
    })
  };

  consoleMessages.push(message);
  if (consoleMessages.length > 1000) {
    consoleMessages.shift();
  }

  originalConsole[type](...args);
}

console.log = (...args) => interceptConsole('log', ...args);
console.warn = (...args) => interceptConsole('warn', ...args);
console.error = (...args) => interceptConsole('error', ...args);
console.info = (...args) => interceptConsole('info', ...args);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.action) {
      case 'getAccessibilityTree':
        sendResponse({ success: true, tree: buildAccessibilityTree() });
        break;

      case 'getPageText':
        sendResponse({ success: true, text: extractPageText() });
        break;

      case 'findElement':
        {
          let element = null;
          if (message.ref) {
            element = findElementByRef(message.ref);
          } else if (message.selector) {
            element = getElementBySelector(message.selector);
          } else if (message.x !== undefined && message.y !== undefined) {
            element = getElementByCoordinates(message.x, message.y);
          }

          if (element) {
            const rect = element.getBoundingClientRect();
            sendResponse({
              success: true,
              element: {
                tagName: element.tagName,
                id: element.id,
                className: element.className,
                bounds: {
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height)
                }
              }
            });
          } else {
            sendResponse({ success: false, error: 'Element not found' });
          }
        }
        break;

      case 'focusElement':
        {
          let element = null;
          if (message.ref) {
            element = findElementByRef(message.ref);
          } else if (message.selector) {
            element = getElementBySelector(message.selector);
          }

          const result = focusElement(element);
          sendResponse({ success: result });
        }
        break;

      case 'setFormValue':
        {
          let element = null;
          if (message.ref) {
            element = findElementByRef(message.ref);
          } else if (message.selector) {
            element = getElementBySelector(message.selector);
          }

          const result = setFormValue(element, message.value);
          sendResponse({ success: result });
        }
        break;

      case 'getFormValue':
        {
          let element = null;
          if (message.ref) {
            element = findElementByRef(message.ref);
          } else if (message.selector) {
            element = getElementBySelector(message.selector);
          }

          sendResponse({ success: true, value: getFormValue(element) });
        }
        break;

      case 'getConsoleMessages':
        sendResponse({ success: true, messages: consoleMessages.slice(-100) });
        break;

      case 'executeScript':
        {
          try {
            const result = eval(message.script);
            sendResponse({ success: true, result });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        }
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }

  return true;
});

log('Content script loaded');
