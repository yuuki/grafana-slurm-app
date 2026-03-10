package settings

import (
	"encoding/json"
	"fmt"
	"net"
	"slices"

	"github.com/go-sql-driver/mysql"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type MetricsType string

const (
	MetricsTypePrometheus      MetricsType = "prometheus"
	MetricsTypeVictoriaMetrics MetricsType = "victoriametrics"
)

type NodeMatcherMode string

const (
	NodeMatcherHostPort NodeMatcherMode = "host:port"
	NodeMatcherHostname NodeMatcherMode = "hostname"
)

type AccessRule struct {
	AllowedRoles []string `json:"allowedRoles"`
	AllowedUsers []string `json:"allowedUsers,omitempty"`
}

func (r AccessRule) AllowsRole(role string) bool {
	if len(r.AllowedRoles) == 0 {
		return true
	}
	return slices.Contains(r.AllowedRoles, role)
}

func (r AccessRule) AllowsUser(login string) bool {
	if len(r.AllowedUsers) == 0 {
		return true
	}
	return slices.Contains(r.AllowedUsers, login)
}

type ConnectionProfile struct {
	ID                string `json:"id"`
	DBHost            string `json:"dbHost"`
	DBName            string `json:"dbName"`
	DBUser            string `json:"dbUser"`
	SecurePasswordRef string `json:"securePasswordRef"`
	Password          string `json:"-"`
}

func (c *ConnectionProfile) Defaults() {
	if c.DBName == "" {
		c.DBName = "slurm_acct_db"
	}
}

func (c ConnectionProfile) DSN() string {
	return buildDSN(c.DBUser, c.Password, c.DBHost, c.DBName)
}

type ClusterProfile struct {
	ID                   string          `json:"id"`
	DisplayName          string          `json:"displayName"`
	ConnectionID         string          `json:"connectionId"`
	SlurmClusterName     string          `json:"slurmClusterName"`
	MetricsDatasourceUID string          `json:"metricsDatasourceUid"`
	MetricsType          MetricsType     `json:"metricsType"`
	InstanceLabel        string          `json:"instanceLabel"`
	NodeExporterPort     string          `json:"nodeExporterPort"`
	DCGMExporterPort     string          `json:"dcgmExporterPort"`
	NodeMatcherMode      NodeMatcherMode `json:"nodeMatcherMode"`
	DefaultTemplateID    string          `json:"defaultTemplateId"`
	MetricsFilterLabel   string          `json:"metricsFilterLabel"`
	MetricsFilterValue   string          `json:"metricsFilterValue"`
	AccessRule           AccessRule      `json:"accessRule"`
}

func (c *ClusterProfile) Defaults() {
	if c.MetricsType == "" {
		c.MetricsType = MetricsTypePrometheus
	}
	if c.NodeExporterPort == "" {
		c.NodeExporterPort = "9100"
	}
	if c.DCGMExporterPort == "" {
		c.DCGMExporterPort = "9400"
	}
	if c.InstanceLabel == "" {
		c.InstanceLabel = "instance"
	}
	if c.NodeMatcherMode == "" {
		c.NodeMatcherMode = NodeMatcherHostPort
	}
	if c.DefaultTemplateID == "" {
		c.DefaultTemplateID = "overview"
	}
}

type Settings struct {
	DBHost            string              `json:"dbHost"`
	DBName            string              `json:"dbName"`
	DBUser            string              `json:"dbUser"`
	DBPassword        string              `json:"-"`
	ClusterName       string              `json:"clusterName"`
	PromDatasourceUID string              `json:"promDatasourceUid"`
	NodeExporterPort  string              `json:"nodeExporterPort"`
	DCGMExporterPort  string              `json:"dcgmExporterPort"`
	InstanceLabel     string              `json:"instanceLabel"`
	Connections       []ConnectionProfile `json:"connections"`
	Clusters          []ClusterProfile    `json:"clusters"`
}

func (s *Settings) Defaults() {
	if s.NodeExporterPort == "" {
		s.NodeExporterPort = "9100"
	}
	if s.DCGMExporterPort == "" {
		s.DCGMExporterPort = "9400"
	}
	if s.InstanceLabel == "" {
		s.InstanceLabel = "instance"
	}
	if s.DBName == "" {
		s.DBName = "slurm_acct_db"
	}
	for idx := range s.Connections {
		s.Connections[idx].Defaults()
	}
	for idx := range s.Clusters {
		s.Clusters[idx].Defaults()
	}
}

func Parse(appSettings backend.AppInstanceSettings) (*Settings, error) {
	var s Settings
	if appSettings.JSONData != nil && len(appSettings.JSONData) > 0 {
		if err := json.Unmarshal(appSettings.JSONData, &s); err != nil {
			return nil, fmt.Errorf("failed to parse settings: %w", err)
		}
	}

	if pw, ok := appSettings.DecryptedSecureJSONData["dbPassword"]; ok {
		s.DBPassword = pw
	}

	s.Defaults()
	for idx := range s.Connections {
		ref := s.Connections[idx].SecurePasswordRef
		if ref == "" {
			continue
		}
		s.Connections[idx].Password = appSettings.DecryptedSecureJSONData[ref]
	}
	if err := s.applyLegacyDefaults(); err != nil {
		return nil, err
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *Settings) DSN() string {
	return buildDSN(s.DBUser, s.DBPassword, s.DBHost, s.DBName)
}

func buildDSN(user, password, host, dbName string) string {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		h = host
		p = "3306"
	}
	cfg := mysql.NewConfig()
	cfg.User = user
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(h, p)
	cfg.DBName = dbName
	cfg.ParseTime = true
	cfg.Params = map[string]string{"charset": "utf8mb4"}
	return cfg.FormatDSN()
}

func (s *Settings) applyLegacyDefaults() error {
	if len(s.Connections) > 0 || len(s.Clusters) > 0 {
		return nil
	}
	if s.DBHost == "" {
		return nil
	}
	s.Connections = []ConnectionProfile{
		{
			ID:       "default",
			DBHost:   s.DBHost,
			DBName:   s.DBName,
			DBUser:   s.DBUser,
			Password: s.DBPassword,
		},
	}
	s.Clusters = []ClusterProfile{
		{
			ID:                   s.ClusterName,
			DisplayName:          s.ClusterName,
			ConnectionID:         "default",
			SlurmClusterName:     s.ClusterName,
			MetricsDatasourceUID: s.PromDatasourceUID,
			InstanceLabel:        s.InstanceLabel,
			NodeExporterPort:     s.NodeExporterPort,
			DCGMExporterPort:     s.DCGMExporterPort,
			NodeMatcherMode:      NodeMatcherHostPort,
			DefaultTemplateID:    "overview",
		},
	}
	s.Defaults()
	return nil
}

func (s *Settings) Validate() error {
	connectionIDs := map[string]struct{}{}
	for _, connection := range s.Connections {
		if connection.ID == "" {
			return fmt.Errorf("connection id is required")
		}
		if _, exists := connectionIDs[connection.ID]; exists {
			return fmt.Errorf("duplicate connection id: %s", connection.ID)
		}
		connectionIDs[connection.ID] = struct{}{}
	}

	clusterIDs := map[string]struct{}{}
	for _, cluster := range s.Clusters {
		if cluster.ID == "" {
			return fmt.Errorf("cluster id is required")
		}
		if cluster.SlurmClusterName == "" {
			return fmt.Errorf("cluster %s missing slurmClusterName", cluster.ID)
		}
		if _, exists := clusterIDs[cluster.ID]; exists {
			return fmt.Errorf("duplicate cluster id: %s", cluster.ID)
		}
		clusterIDs[cluster.ID] = struct{}{}
		if cluster.ConnectionID != "" {
			if _, ok := connectionIDs[cluster.ConnectionID]; !ok {
				return fmt.Errorf("cluster %s references unknown connection %s", cluster.ID, cluster.ConnectionID)
			}
		}
	}
	return nil
}
