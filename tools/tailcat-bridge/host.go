package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

// savedHost is the key file: what keeps a host's address the same across restarts.
// Deleting the file rotates the address; everyone who had the old one is shut out.
type savedHost struct {
	Key          key.NodePrivate      `json:"key"`
	PresharedKey tailcat.PresharedKey `json:"presharedKey"`
	RegionID     tailcfg.DERPRegionID `json:"regionId"`
}

// keyFileMode keeps the key file owner-only: the address it yields admits anyone.
const keyFileMode fs.FileMode = 0o600

func runHost(args []string) error {
	flags := flag.NewFlagSet("host", flag.ContinueOnError)
	localPort := flags.Uint("local-port", 0, "port the Terrace server listens on (required)")
	keyFile := flags.String("key-file", "", "keeps the address across restarts; empty means a new address each run")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *localPort == 0 || *localPort > 0xFFFF {
		return fmt.Errorf("--local-port must be 1-65535")
	}

	saved, err := loadSavedHost(*keyFile)
	if err != nil {
		return err
	}
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(*localPort)))
	s := &tailcat.Server{
		Logf:           logf,
		ServedTCPPorts: []filter.PortRange{{First: TunnelPort, Last: TunnelPort}},
		OnTCP: func(port uint16) func(net.Conn) {
			if port != TunnelPort {
				return nil
			}
			return func(c net.Conn) { proxyTo(c, target) }
		},
	}
	switch {
	case saved != nil:
		s.Key, s.PresharedKey, s.RegionID = saved.Key, saved.PresharedKey, saved.RegionID
	case *keyFile != "":
		// Start does not hand back keys it generates, so make the ones to save here.
		s.Key, s.PresharedKey = key.NewNode(), tailcat.NewPresharedKey()
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("starting tailcat server: %w", err)
	}
	defer s.Close()

	addr := s.TailcatAddr()
	if *keyFile != "" && saved == nil {
		if err := saveHost(*keyFile, s, addr); err != nil {
			return err
		}
	}
	report(map[string]string{"address": string(addr)})
	untilStdinCloses()
	return nil
}

// proxyTo joins a tunnel connection to the local server; a refused dial just drops the guest's connection.
func proxyTo(c net.Conn, target string) {
	local, err := net.Dial("tcp", target)
	if err != nil {
		logf("tailcat-bridge: dialing %s: %v", target, err)
		c.Close()
		return
	}
	tailcat.ProxyConns(c, local)
}

// loadSavedHost returns nil when there is no key file yet (or none was asked for).
func loadSavedHost(path string) (*savedHost, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading key file: %w", err)
	}
	var saved savedHost
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, fmt.Errorf("key file %s is not valid: %w", path, err)
	}
	return &saved, nil
}

// saveHost records the started server's identity and the region it picked, so the
// next run re-listens at the same address instead of re-picking a region.
func saveHost(path string, s *tailcat.Server, addr tailcat.Addr) error {
	info, err := tailcat.ParseAddr(addr)
	if err != nil {
		return fmt.Errorf("parsing own address: %w", err)
	}
	data, err := json.Marshal(savedHost{Key: s.Key, PresharedKey: s.PresharedKey, RegionID: info.RegionID})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("creating key directory: %w", err)
	}
	// Write then rename, so a crash never leaves a half-written key file.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, keyFileMode); err != nil {
		return fmt.Errorf("writing key file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("writing key file: %w", err)
	}
	return nil
}
