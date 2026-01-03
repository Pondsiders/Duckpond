"""MOOSE CLI entry point."""

import argparse
import uvicorn


def main():
    parser = argparse.ArgumentParser(
        prog="moose",
        description="MOOSE - MAlpha Out Of Claude Code SoonEst",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # serve command
    serve_parser = subparsers.add_parser("serve", help="Start the MOOSE server")
    serve_parser.add_argument(
        "--port", "-p",
        type=int,
        default=8000,
        help="Port to listen on (default: 8000)",
    )
    serve_parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)",
    )
    serve_parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )

    args = parser.parse_args()

    if args.command == "serve":
        uvicorn.run(
            "moose.server:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
        )


if __name__ == "__main__":
    main()
