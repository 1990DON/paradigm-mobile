import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';

type Coordinate = {
  latitude: number;
  longitude: number;
};

type NodeState = 'ACTIVE' | 'BOOSTED' | 'FAMILIAR' | 'NEW';

type ParadigmNode = {
  id: string;
  name: string;
  emoji: string;
  state: NodeState;
  xp: number;
  coordinate: Coordinate;
};

export default function App() {
  const [region, setRegion] = useState<Region | null>(null);
  const [userLocation, setUserLocation] =
    useState<Coordinate | null>(null);

  const [worldStatus, setWorldStatus] =
    useState('LOCATING...');

    const [ selectedNode, setSelectedNode ] = useState<ParadigmNode | null>(null);

  useEffect(() => {
    async function startWorld() {
      const permission =
        await Location.requestForegroundPermissionsAsync();

      if (permission.status !== 'granted') {
        const fallback = {
          latitude: 40.8075,
          longitude: -73.9626,
        };

        setRegion({
          ...fallback,
          latitudeDelta: 0.012,
          longitudeDelta: 0.012,
        });

        setWorldStatus('LOCATION NEEDED');
        return;
      }

      const location =
        await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

      const coordinate = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };

      setUserLocation(coordinate);

      setRegion({
        ...coordinate,
        latitudeDelta: 0.012,
        longitudeDelta: 0.012,
      });

      setWorldStatus('WORLD LIVE');
    }

    startWorld();
  }, []);

  const nodes = useMemo<ParadigmNode[]>(() => {
    if (!region) return [];

    const center = userLocation ?? {
      latitude: region.latitude,
      longitude: region.longitude,
    };

    return [
      {
        id: 'court',
        name: 'Basketball Court',
        emoji: '🏀',
        state: 'ACTIVE',
        xp: 45,
        coordinate: {
          latitude: center.latitude + 0.0024,
          longitude: center.longitude + 0.001,
        },
      },

      {
        id: 'bodega',
        name: 'Neighborhood Bodega',
        emoji: '🛒',
        state: 'FAMILIAR',
        xp: 12,
        coordinate: {
          latitude: center.latitude - 0.0012,
          longitude: center.longitude + 0.002,
        },
      },

      {
        id: 'transit',
        name: 'Transit Zone',
        emoji: '🚇',
        state: 'BOOSTED',
        xp: 28,
        coordinate: {
          latitude: center.latitude + 0.0008,
          longitude: center.longitude - 0.0023,
        },
      },

      {
        id: 'park',
        name: 'Park',
        emoji: '🌳',
        state: 'NEW',
        xp: 20,
        coordinate: {
          latitude: center.latitude - 0.0023,
          longitude: center.longitude - 0.001,
        },
      },
    ];
  }, [region, userLocation]);

  if (!region) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />

        <Text style={styles.logo}>
          PARADIGM
        </Text>

        <ActivityIndicator
          size="large"
          color="#ffffff"
        />

        <Text style={styles.loadingText}>
          {worldStatus}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        showsUserLocation={!!userLocation}
        showsCompass={false}
      >
        {nodes.map((node) => (
          <Marker
            key={node.id}
            coordinate={node.coordinate}
            onPress={() => setSelectedNode(node)}
            title={node.name}
            description={`${node.state} · +${node.xp} XP`}
          >
            <View
              style={[
                styles.node,

                node.state === 'BOOSTED' &&
                  styles.boostedNode,

                node.state === 'FAMILIAR' &&
                  styles.familiarNode,

                node.state === 'NEW' &&
                  styles.newNode,
              ]}
            >
              <Text style={styles.nodeEmoji}>
                {node.emoji}
              </Text>
            </View>
          </Marker>
        ))}
      </MapView>

      <View style={styles.topBar}>
        <View>
          <Text style={styles.logo}>
            PARADIGM
          </Text>

          <View style={styles.liveRow}>
            <View style={styles.liveDot} />

            <Text style={styles.liveText}>
              {worldStatus}
            </Text>
          </View>
        </View>

        <View style={styles.xpBox}>
          <Text style={styles.xpValue}>
            0
          </Text>

          <Text style={styles.xpLabel}>
            XP TODAY
          </Text>
        </View>
      </View>

      {selectedNode ? (
  <View style={styles.bottomPanel}>
    <View style={styles.nodePanelHeader}>
      <View>
        <Text style={styles.nodePanelState}>
          {selectedNode.state}
        </Text>

        <Text style={styles.nodePanelTitle}>
          {selectedNode.emoji} {selectedNode.name}
        </Text>
      </View>

      <Pressable
        onPress={() => setSelectedNode(null)}
        style={styles.closeButton}
      >
        <Text style={styles.closeButtonText}>×</Text>
      </Pressable>
    </View>

    <Text style={styles.nodePanelXP}>
      +{selectedNode.xp} XP opportunity
    </Text>

    <Text style={styles.nodePanelMeaning}>
      {selectedNode.id === 'court' &&
        'Activity is happening here. Participate to build court history.'}

      {selectedNode.id === 'bodega' &&
        'A familiar place in your world. Repeated visits strengthen your relationship here.'}

      {selectedNode.id === 'transit' &&
        'Movement is boosted in this zone right now.'}

      {selectedNode.id === 'park' &&
        'New territory. Explore this place to begin building history.'}
    </Text>

    <Pressable style={styles.participateButton}>
      <Text style={styles.participateButtonText}>
        {selectedNode.id === 'court'
          ? 'BEGIN PARTICIPATION'
          : 'VIEW OPPORTUNITY'}
      </Text>
    </Pressable>
  </View>
) : (
  <View style={styles.bottomPanel}>
    <Text style={styles.worldTitle}>
      YOUR WORLD IS ACTIVE
    </Text>

    <Text style={styles.worldSubtitle}>
      Move through the city. Participate. Build history.
    </Text>
  </View>
)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  loading: {
    flex: 1,
    backgroundColor: '#101014',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },

  loadingText: {
    color: '#9b9ba3',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },

  topBar: {
    position: 'absolute',
    top: 58,
    left: 18,
    right: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',

    backgroundColor:
      'rgba(15,15,19,0.92)',

    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },

  logo: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 20,
    letterSpacing: 2,
  },

  liveRow: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },

  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 7,
    backgroundColor: '#7DFF89',
  },

  liveText: {
    color: '#aaaaaf',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },

  xpBox: {
    alignItems: 'flex-end',
  },

  xpValue: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
  },

  xpLabel: {
    color: '#aaaaaf',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },

  node: {
    width: 48,
    height: 48,
    borderRadius: 24,

    backgroundColor: '#16161D',

    borderWidth: 3,
    borderColor: '#ffffff',

    justifyContent: 'center',
    alignItems: 'center',
  },

  boostedNode: {
    borderColor: '#B79CFF',
    transform: [{ scale: 1.14 }],
  },

  familiarNode: {
    borderColor: '#78D7FF',
  },

  newNode: {
    borderStyle: 'dashed',
  },

  nodeEmoji: {
    fontSize: 22,
  },

  bottomPanel: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 40,

    backgroundColor:
      'rgba(15,15,19,0.94)',

    borderRadius: 20,
    padding: 18,
  },

  worldTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.2,
  },

  worldSubtitle: {
    color: '#aaaaaf',
    marginTop: 5,
    fontSize: 13,
  },
  nodePanelHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
},

nodePanelState: {
  color: '#7DFF89',
  fontSize: 10,
  fontWeight: '800',
  letterSpacing: 1.4,
  marginBottom: 5,
},

nodePanelTitle: {
  color: '#ffffff',
  fontSize: 21,
  fontWeight: '800',
},

nodePanelXP: {
  color: '#ffffff',
  fontSize: 14,
  fontWeight: '700',
  marginTop: 16,
},

nodePanelMeaning: {
  color: '#aaaaaf',
  fontSize: 13,
  lineHeight: 19,
  marginTop: 7,
},

closeButton: {
  width: 34,
  height: 34,
  borderRadius: 17,
  backgroundColor: '#292930',
  alignItems: 'center',
  justifyContent: 'center',
},

closeButtonText: {
  color: '#ffffff',
  fontSize: 24,
  lineHeight: 26,
},

participateButton: {
  backgroundColor: '#ffffff',
  borderRadius: 14,
  paddingVertical: 14,
  alignItems: 'center',
  marginTop: 18,
},

participateButtonText: {
  color: '#101014',
  fontSize: 12,
  fontWeight: '900',
  letterSpacing: 1,
},
});