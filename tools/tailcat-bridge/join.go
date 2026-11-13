package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/tailscale/tailcat"
)

// connectTimeout bounds reaching the host before the parent is told it failed.
// Estimate: a DERP map fetch plus a relay handshake on a slow link, with margin.
const connectTimeout = 20 * time.Second

func runJoin(args []string) error {
	flags := flag.NewFlagSet("join", flag.ContinueOnError)
	// The page's origin is this port, and the player's token lives in that origin's
	// storage, so the parent passes the same port for the same host every time.
	listenPort := flags.Uint("listen-port", 0, "local port to serve the host on; 0 lets the OS pick")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("join takes exactly one tailcat address")
	}
	if *listenPort > 0xFFFF {
		return fmt.Errorf("--listen-port must be 0-65535")
	}
	addr := tailcat.Addr(flags.Arg(0))
	if _, err := tailcat.ParseAddr(addr); err != nil {
		return fmt.Errorf("not a tailcat address: %w", err)
	}

	cl := &tailcat.Client{Server: addr, Logf: logf}
	defer cl.Close()
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	_, err := cl.Ping(ctx)
	cancel()
	if err != nil {
		return fmt.Errorf("host did not answer: %w", err)
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(*listenPort))))
	if err != nil {
		return fmt.Errorf("listening locally: %w", err)
	}
	defer ln.Close()
	go serveJoin(ln, cl)

	report(map[string]int{"localPort": ln.Addr().(*net.TCPAddr).Port})
	untilStdinCloses()
	return nil
}

// serveJoin tunnels each local connection to the host until the listener closes.
func serveJoin(ln net.Listener, cl *tailcat.Client) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			remote, err := cl.DialTCPPort(context.Background(), TunnelPort)
			if err != nil {
				logf("tailcat-bridge: dialing host: %v", err)
				c.Close()
				return
			}
			tailcat.ProxyConns(c, remote)
		}()
	}
}
