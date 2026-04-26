const WebSocket = require('ws');
const fs = require('fs');
const PORT = parseInt(process.env.MOCK_PORT || '19231');

const wss = new WebSocket.Server({ port: PORT });

// Mock widget tree
const MOCK_TREE = {
  widgetRuntimeType: 'MaterialApp',
  label: 'Test App',
  children: [
    {
      widgetRuntimeType: 'Scaffold',
      label: '',
      children: [
        { widgetRuntimeType: 'AppBar', label: 'Home', textPreview: 'Home', children: [] },
        {
          widgetRuntimeType: 'Column',
          label: '',
          children: [
            { widgetRuntimeType: 'Text', label: 'Hello World', textPreview: 'Hello World', children: [] },
            { widgetRuntimeType: 'ElevatedButton', label: 'Submit', hasAction: true, children: [] },
            { widgetRuntimeType: 'TextField', label: 'Enter name', hasAction: true, isFocusable: true, children: [] },
            { widgetRuntimeType: 'Checkbox', label: 'Agree', hasAction: true, value: 'false', children: [] },
            { widgetRuntimeType: 'IconButton', label: 'Settings', hasAction: true, children: [] },
            { widgetRuntimeType: 'Switch', label: 'Dark mode', hasAction: true, value: 'off', children: [] },
            { widgetRuntimeType: 'Slider', label: 'Volume', hasAction: true, value: '50', children: [] },
            { widgetRuntimeType: 'ListTile', label: 'Profile', hasAction: true, children: [] },
          ]
        }
      ]
    }
  ]
};

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const { id, method, params } = msg;
    let result;

    switch (method) {
      case 'getVM':
        result = { isolates: [{ id: 'isolates/main', name: 'main' }] };
        break;

      case 'ext.flutter.inspector.getRootWidgetSummaryTree':
        result = MOCK_TREE;
        break;

      case 'ext.flutter.inspector.getRootRenderObject':
        result = MOCK_TREE;
        break;

      case 'ext.flutter.driver':
        // Handle driver commands
        const cmd = params?.command;
        switch (cmd) {
          case 'tap':
            result = { status: 'ok' };
            break;
          case 'enter_text':
            result = { status: 'ok', text: params.text };
            break;
          case 'scroll':
            result = { status: 'ok', dx: params.dx, dy: params.dy };
            break;
          case 'screenshot':
            // Return a tiny 1x1 red PNG as base64
            const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            result = { screenshot: PNG_1x1 };
            break;
          case 'request_data':
            result = { status: 'ok', message: params.message };
            break;
          default:
            result = { status: 'ok', command: cmd };
        }
        break;

      case '_flutter.screenshot':
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
        result = { screenshot: PNG };
        break;

      default:
        result = { type: 'Sentinel', kind: 'Collected', valueAsString: 'not implemented' };
    }

    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

console.log(`Mock Flutter VM service on ws://127.0.0.1:${PORT}/ws`);
