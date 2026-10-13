from http.server import BaseHTTPRequestHandler
import json
import math
import re
from urllib.parse import parse_qs, urlparse

import yfinance as yf


SYMBOL_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9./_-]{0,19}$")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        symbols = list(dict.fromkeys(
            symbol.strip().upper()
            for value in query.get("symbols", [])
            for symbol in value.split(",")
            if symbol.strip()
        ))
        crypto_symbols = {
            symbol.strip().upper()
            for value in query.get("cryptoSymbols", [])
            for symbol in value.split(",")
            if symbol.strip()
        }

        if (
            not symbols
            or len(symbols) > 5
            or any(not SYMBOL_PATTERN.fullmatch(symbol) for symbol in symbols)
            or not crypto_symbols.issubset(symbols)
        ):
            self._send_json(400, {"error": "Provide 1-5 valid symbols."})
            return

        results = []
        for symbol in symbols:
            try:
                results.append(self._get_result(symbol, symbol in crypto_symbols))
            except Exception as error:
                results.append({"symbol": symbol, "error": str(error)})

        self._send_json(200, {"results": results})

    def _get_result(self, symbol, is_crypto):
        ticker = to_yahoo_ticker(symbol, is_crypto)
        history = yf.Ticker(ticker).history(
            period="5d",
            interval="15m",
            auto_adjust=False,
            actions=False,
            raise_errors=True,
        )
        if history.empty:
            raise ValueError(f"Yahoo Finance returned no 15-minute candles for {ticker}.")

        candles = []
        for timestamp, row in history.iterrows():
            values = [row.get(column) for column in ("Open", "High", "Low", "Close")]
            if any(value is None or not math.isfinite(float(value)) for value in values):
                continue
            volume = row.get("Volume")
            candles.append({
                "time": int(timestamp.timestamp()),
                "open": float(values[0]),
                "high": float(values[1]),
                "low": float(values[2]),
                "close": float(values[3]),
                "volume": float(volume) if volume is not None and math.isfinite(float(volume)) else None,
            })

        if not candles:
            raise ValueError(f"Yahoo Finance returned no valid 15-minute candles for {ticker}.")
        return {
            "symbol": symbol,
            "currency": "USD",
            "ticker": ticker,
            "candles": candles[-150:],
        }

    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        print(f"yfinance endpoint: {format_string % args}")


def to_yahoo_ticker(symbol, is_crypto):
    if "/" not in symbol:
        return symbol
    base, quote = symbol.split("/", maxsplit=1)
    if is_crypto:
        return f"{base}-{quote}"
    return f"{base}{quote}=X"
