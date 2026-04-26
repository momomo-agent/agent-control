#!/usr/bin/env python3
"""
agent-control iOS real-device backend — pymobiledevice3 bridge

Wraps pymobiledevice3 async APIs into a synchronous JSON CLI
that index.js can call as a subprocess.

Usage:
  python3 real-device.py detect                     → list connected devices
  python3 real-device.py snapshot [--interactive]    → AX element tree
  python3 real-device.py tap <x> <y>                → tap coordinates
  python3 real-device.py tap-element <uid>           → tap AX element by uid
  python3 real-device.py type <text>                 → type text
  python3 real-device.py swipe <dir> [amount]        → swipe gesture
  python3 real-device.py press <button>              → press button (home/lock/volumeUp/volumeDown)
  python3 real-device.py screenshot [path]           → save screenshot PNG
  python3 real-device.py launch <bundleId>           → launch app
  python3 real-device.py terminate <bundleId>        → kill app
  python3 real-device.py unlock                      → unlock device
  python3 real-device.py install <ipa_path>          → install IPA
  python3 real-device.py uninstall <bundleId>        → uninstall app
  python3 real-device.py list-apps                   → list installed apps
  python3 real-device.py source                      → raw WDA XML source
  python3 real-device.py info                        → device info
  python3 real-device.py devicename                  → just the device name
"""

import asyncio
import json
import sys
import os
import base64
import tempfile

# Suppress urllib3 LibreSSL warning
import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*LibreSSL.*")
warnings.filterwarnings("ignore", message=".*NotOpenSSLWarning.*")


def out(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))
    sys.exit(0)


def err(msg):
    out({"ok": False, "error": str(msg)})


# ── Device discovery ──

async def get_device():
    """Find first connected real device via usbmux or remote."""
    try:
        from pymobiledevice3.usbmux import list_devices
        devices = list_devices()
        if asyncio.iscoroutine(devices):
            devices = await devices
        if devices:
            from pymobiledevice3.lockdown import create_using_usbmux
            ld = create_using_usbmux(serial=devices[0].serial)
            if asyncio.iscoroutine(ld):
                ld = await ld
            return ld
    except Exception:
        pass

    # Try remote (iOS 17+ tunnel)
    try:
        from pymobiledevice3.remote.module_helper import list_remotes
        remotes = list_remotes()
        if asyncio.iscoroutine(remotes):
            remotes = await remotes
        if remotes:
            from pymobiledevice3.lockdown import create_using_remote
            ld = create_using_remote(hostname=remotes[0].hostname, identifier=remotes[0].identifier)
            if asyncio.iscoroutine(ld):
                ld = await ld
            return ld
    except Exception:
        pass

    return None


async def get_tunnel_service_provider():
    """For iOS 17+, get a RemoteServiceDiscovery provider via tunnel."""
    try:
        from pymobiledevice3.remote.module_helper import list_remotes
        remotes = list_remotes()
        if remotes:
            from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
            rsd = RemoteServiceDiscoveryService(remotes[0])
            rsd.connect()
            return rsd
    except Exception:
        pass
    return None


# ── Commands ──

async def cmd_detect():
    """List connected real devices."""
    results = []
    try:
        from pymobiledevice3.usbmux import list_devices
        devs = list_devices()
        # list_devices may be sync or async depending on version
        if asyncio.iscoroutine(devs):
            devs = await devs
        for d in devs:
            results.append({
                "serial": d.serial,
                "connection_type": d.connection_type,
            })
    except Exception:
        pass
    out({"ok": True, "devices": results})


async def cmd_info():
    ld = await get_device()
    if not ld:
        err("no real device connected")
    info = {
        "name": ld.display_name,
        "udid": ld.udid,
        "product_type": ld.product_type,
        "os_version": ld.product_version,
        "build_version": ld.get_value(key="BuildVersion"),
    }
    out({"ok": True, "info": info})


async def cmd_devicename():
    ld = await get_device()
    if not ld:
        err("no real device connected")
    out({"ok": True, "name": ld.display_name})


async def cmd_snapshot(interactive_only=False):
    """Get AX element tree via accessibility audit service."""
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit

    INTERACTIVE_TYPES = {
        "Button", "TextField", "SecureTextField", "TextView", "Switch",
        "Slider", "Link", "Tab", "SegmentedControl", "SearchField",
        "PopUpButton", "ComboBox", "CheckBox", "Stepper", "Picker",
        "DatePicker", "Toggle",
    }

    elements = []
    counter = 0
    async with AccessibilityAudit(ld) as service:
        async for el in service.iter_elements():
            d = el.to_dict()
            caption = d.get("caption", "") or ""
            spoken = d.get("spoken_description", "") or ""
            uid = d.get("platform_identifier", "")

            # Determine role from caption/spoken (best effort)
            role = "Unknown"
            is_interactive = False
            for t in INTERACTIVE_TYPES:
                if t.lower() in caption.lower() or t.lower() in spoken.lower():
                    role = t
                    is_interactive = True
                    break

            if interactive_only and not is_interactive:
                continue

            counter += 1
            elements.append({
                "ref": f"@e{counter}",
                "role": role,
                "label": caption,
                "spoken": spoken,
                "uid": uid,
                "interactive": is_interactive,
            })

    out({"ok": True, "action": "snapshot", "count": len(elements), "elements": elements})


async def cmd_source():
    """Get raw WDA XML source tree (richer than AX audit)."""
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        source = await client.get_source()
    out({"ok": True, "action": "source", "xml": source})


async def cmd_screenshot(path=None):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.screenshot import ScreenshotService

    svc = ScreenshotService(ld)
    png_data = await svc.take_screenshot()

    if path is None:
        path = tempfile.mktemp(suffix=".png", prefix="agent-control-ios-")

    with open(path, "wb") as f:
        f.write(png_data)

    out({"ok": True, "action": "screenshot", "path": path, "size": len(png_data)})


async def cmd_tap(x, y):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session()
        # WDA tap via coordinate — find element at point or use touchAndHold
        # Use the /wda/tap endpoint
        await client._request_json("POST", f"/session/{sid}/wda/tap/0", {
            "x": float(x), "y": float(y)
        })
    out({"ok": True, "action": "tap", "x": x, "y": y})


async def cmd_tap_element(uid):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit

    async with AccessibilityAudit(ld) as service:
        async for el in service.iter_elements():
            d = el.to_dict()
            if d.get("platform_identifier") == uid:
                await service.perform_press(el.element)
                out({"ok": True, "action": "tap-element", "uid": uid})
        err(f"element with uid '{uid}' not found")


async def cmd_type(text):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session()
        await client.send_keys(text, session_id=sid)
    out({"ok": True, "action": "type", "text": text})


async def cmd_swipe(direction, amount=0.5):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session()
        size = await client.get_window_size(session_id=sid)
        w, h = size["width"], size["height"]
        cx, cy = w / 2, h / 2
        dist_x = w * float(amount)
        dist_y = h * float(amount)

        coords = {
            "up":    (cx, cy + dist_y / 2, cx, cy - dist_y / 2),
            "down":  (cx, cy - dist_y / 2, cx, cy + dist_y / 2),
            "left":  (cx + dist_x / 2, cy, cx - dist_x / 2, cy),
            "right": (cx - dist_x / 2, cy, cx + dist_x / 2, cy),
        }
        if direction not in coords:
            err(f"invalid direction '{direction}', use up/down/left/right")

        sx, sy, ex, ey = coords[direction]
        await client.swipe(sx, sy, ex, ey, 0.3, session_id=sid)
    out({"ok": True, "action": "swipe", "direction": direction})


async def cmd_press(button):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session()
        await client.press_button(button, session_id=sid)
    out({"ok": True, "action": "press", "button": button})


async def cmd_launch(bundle_id):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session(bundle_id=bundle_id)
    out({"ok": True, "action": "launch", "bundleId": bundle_id, "sessionId": sid})


async def cmd_terminate(bundle_id):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    # Use DVT process control to kill by bundle id
    try:
        from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
        from pymobiledevice3.services.dvt.dvt_secure_socket_proxy import DvtSecureSocketProxyService

        async with DvtSecureSocketProxyService(lockdown=ld) as dvt:
            pc = ProcessControl(dvt)
            await pc.kill_by_bundle_id(bundle_id)
        out({"ok": True, "action": "terminate", "bundleId": bundle_id})
    except Exception as e:
        err(f"terminate failed: {e}")


async def cmd_unlock():
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.wda import AsyncWdaClient

    async with AsyncWdaClient(ld) as client:
        sid = await client.start_session()
        await client.unlock(session_id=sid)
    out({"ok": True, "action": "unlock"})


async def cmd_install(ipa_path):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.installation_proxy import InstallationProxyService

    svc = InstallationProxyService(ld)
    svc.install_from_local(ipa_path)
    out({"ok": True, "action": "install", "path": ipa_path})


async def cmd_uninstall(bundle_id):
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.installation_proxy import InstallationProxyService

    svc = InstallationProxyService(ld)
    svc.uninstall(bundle_id)
    out({"ok": True, "action": "uninstall", "bundleId": bundle_id})


async def cmd_list_apps():
    ld = await get_device()
    if not ld:
        err("no real device connected")

    from pymobiledevice3.services.installation_proxy import InstallationProxyService

    svc = InstallationProxyService(ld)
    apps = svc.get_apps("User")
    result = []
    for bid, info in apps.items():
        result.append({
            "bundleId": bid,
            "name": info.get("CFBundleDisplayName") or info.get("CFBundleName", ""),
            "version": info.get("CFBundleShortVersionString", ""),
        })
    result.sort(key=lambda a: a["name"].lower())
    out({"ok": True, "action": "list-apps", "count": len(result), "apps": result})


# ── Main dispatch ──

def main():
    if len(sys.argv) < 2:
        err("usage: real-device.py <command> [args...]")

    cmd = sys.argv[1]
    args = sys.argv[2:]

    try:
        if cmd == "detect":
            asyncio.run(cmd_detect())
        elif cmd == "info":
            asyncio.run(cmd_info())
        elif cmd == "devicename":
            asyncio.run(cmd_devicename())
        elif cmd == "snapshot":
            interactive = "--interactive" in args or "-i" in args
            asyncio.run(cmd_snapshot(interactive))
        elif cmd == "source":
            asyncio.run(cmd_source())
        elif cmd == "screenshot":
            path = args[0] if args and not args[0].startswith("-") else None
            asyncio.run(cmd_screenshot(path))
        elif cmd == "tap":
            if len(args) >= 2:
                asyncio.run(cmd_tap(float(args[0]), float(args[1])))
            else:
                err("tap requires x y coordinates")
        elif cmd == "tap-element":
            if args:
                asyncio.run(cmd_tap_element(args[0]))
            else:
                err("tap-element requires uid")
        elif cmd == "type":
            if args:
                asyncio.run(cmd_type(" ".join(args)))
            else:
                err("type requires text")
        elif cmd == "swipe":
            if args:
                amount = float(args[1]) if len(args) > 1 else 0.5
                asyncio.run(cmd_swipe(args[0], amount))
            else:
                err("swipe requires direction (up/down/left/right)")
        elif cmd == "press":
            if args:
                asyncio.run(cmd_press(args[0]))
            else:
                err("press requires button name")
        elif cmd == "launch":
            if args:
                asyncio.run(cmd_launch(args[0]))
            else:
                err("launch requires bundleId")
        elif cmd == "terminate":
            if args:
                asyncio.run(cmd_terminate(args[0]))
            else:
                err("terminate requires bundleId")
        elif cmd == "unlock":
            asyncio.run(cmd_unlock())
        elif cmd == "install":
            if args:
                asyncio.run(cmd_install(args[0]))
            else:
                err("install requires ipa path")
        elif cmd == "uninstall":
            if args:
                asyncio.run(cmd_uninstall(args[0]))
            else:
                err("uninstall requires bundleId")
        elif cmd == "list-apps":
            asyncio.run(cmd_list_apps())
        else:
            err(f"unknown command '{cmd}'")
    except Exception as e:
        err(str(e))


if __name__ == "__main__":
    main()
