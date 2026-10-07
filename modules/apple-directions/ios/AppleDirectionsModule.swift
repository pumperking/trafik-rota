import ExpoModulesCore
import MapKit

public class AppleDirectionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppleDirections")

    AsyncFunction("getRoutes") { (fromLat: Double, fromLon: Double, toLat: Double, toLon: Double, promise: Promise) in
      let request = MKDirections.Request()
      request.source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: fromLat, longitude: fromLon)))
      request.destination = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: toLat, longitude: toLon)))
      request.transportType = .automobile
      request.departureDate = Date()
      request.requestsAlternateRoutes = true

      MKDirections(request: request).calculate { response, error in
        guard let routes = response?.routes, !routes.isEmpty else {
          promise.reject("ERR_APPLE_DIRECTIONS", error?.localizedDescription ?? "Rota bulunamadı")
          return
        }

        let serialized: [[String: Any]] = routes.map { route in
          let count = route.polyline.pointCount
          var coords = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: count)
          route.polyline.getCoordinates(&coords, range: NSRange(location: 0, length: count))
          return [
            "routeSeconds": route.expectedTravelTime,
            "distanceMeters": route.distance,
            "name": route.name,
            "advisoryNotices": route.advisoryNotices,
            "coordinates": coords.map { ["latitude": $0.latitude, "longitude": $0.longitude] }
          ]
        }

        // The ETA request is Apple's traffic-aware estimate; the route's own time may not be.
        MKDirections(request: request).calculateETA { eta, _ in
          var result: [String: Any] = ["routes": serialized]
          if let eta = eta {
            result["etaSeconds"] = eta.expectedTravelTime
          }
          promise.resolve(result)
        }
      }
    }.runOnQueue(.main)
  }
}
