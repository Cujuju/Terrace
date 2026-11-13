// Command tailcat-bridge carries a Terrace server over tailcat for the desktop app.
//
//	tailcat-bridge host --local-port=2567 [--key-file=PATH]
//	tailcat-bridge join --listen-port=0 tc...
//
// Each mode prints one JSON line on stdout once ready ({"address":…} or {"localPort":…}),
// or {"error":…} and exits 1. Both exit when stdin closes, so the bridge dies with its parent.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
)

// TunnelPort is the port the game is served on inside the tunnel, whatever the host's
// local port. 80 lets the stock CLI open a host too: `tailcat browse tc…`.
const TunnelPort uint16 = 80

func main() {
	if len(os.Args) < 2 {
		fail(fmt.Errorf("usage: tailcat-bridge host|join [flags]"))
	}
	var err error
	switch os.Args[1] {
	case "host":
		err = runHost(os.Args[2:])
	case "join":
		err = runJoin(os.Args[2:])
	default:
		err = fmt.Errorf("unknown mode %q; want host or join", os.Args[1])
	}
	if err != nil {
		fail(err)
	}
}

// report writes the one ready line the parent waits for.
func report(v any) {
	if err := json.NewEncoder(os.Stdout).Encode(v); err != nil {
		log.Fatalf("tailcat-bridge: writing stdout: %v", err)
	}
}

func fail(err error) {
	report(map[string]string{"error": err.Error()})
	os.Exit(1)
}

// untilStdinCloses blocks until the parent closes stdin or exits.
func untilStdinCloses() {
	_, _ = io.Copy(io.Discard, os.Stdin)
}

// logf is tailcat's debug logger: stderr when TAILCAT_BRIDGE_VERBOSE is set, else silent.
func logf(format string, args ...any) {
	if os.Getenv("TAILCAT_BRIDGE_VERBOSE") != "" {
		log.Printf(format, args...)
	}
}
